import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Refund, Ticket, Incident, Trip } from '../entities';
import { IncidentsService } from '../incidents/incidents.service';
import { TransferService } from '../transfer/transfer.service';
import { now } from '../common';

@Injectable()
export class ServiceService {
  constructor(
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectRepository(Incident) private readonly incidents: Repository<Incident>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    private readonly incidentSvc: IncidentsService,
    private readonly transferSvc: TransferService,
  ) {}

  /** 客服工作台：待办退票 + 开放事件 */
  async workbench() {
    const [pendingRefunds, openIncidents, escalated] = await Promise.all([
      this.refunds.find({ where: { status: 'pending' }, order: { id: 'ASC' } }),
      this.incidents.find({
        where: { status: 'open' as any }, order: { id: 'ASC' },
      }),
      this.refunds.find({ where: { status: 'escalated' }, order: { id: 'ASC' } }),
    ]);
    const ticketRows = await this.tickets.find();
    const tMap = new Map(ticketRows.map(t => [t.id, t]));
    // 退票处理时可查看该票的完整行程变化（误乘换乘方案 + 关联事件时间线）
    const [allPlans, allIncidents] = await Promise.all([
      this.transferSvc.list(),
      this.incidents.find({ order: { id: 'ASC' } }),
    ]);
    const transferByTicket = new Map<number, any[]>();
    for (const p of allPlans) {
      const arr = transferByTicket.get(p.ticketId) || [];
      arr.push(p);
      transferByTicket.set(p.ticketId, arr);
    }
    const timelineByTicket = new Map<number, Incident[]>();
    for (const inc of allIncidents) {
      if (!inc.ticketId) continue;
      const arr = timelineByTicket.get(inc.ticketId) || [];
      arr.push(inc);
      timelineByTicket.set(inc.ticketId, arr);
    }
    const withTicket = (r: Refund) => {
      const ticket = tMap.get(r.ticketId);
      return {
        ...r,
        ticket,
        transferPlans: ticket ? transferByTicket.get(ticket.id) || [] : [],
        incidentTimeline: ticket ? timelineByTicket.get(ticket.id) || [] : [],
      };
    };
    return {
      pendingRefunds: pendingRefunds.map(withTicket),
      escalatedRefunds: escalated.map(withTicket),
      openIncidents,
      counts: {
        pendingRefund: pendingRefunds.length,
        escalated: escalated.length,
        openIncident: openIncidents.length,
      },
    };
  }

  /** 客服直接同意退票（责任明确：暴雨/车辆/调度）→ 待财务付款 */
  async approve(refundId: number, note: string) {
    const r = await this.refunds.findOne({ where: { id: refundId } });
    if (!r) throw new NotFoundException('退票单不存在');
    if (r.status !== 'pending') throw new BadRequestException(`退票单状态 ${r.status}，不可审批`);
    r.status = 'approved';
    r.serviceNote = note;
    r.processedAt = now();
    await this.refunds.save(r);
    const t = await this.tickets.findOne({ where: { id: r.ticketId } });
    if (t) { t.status = 'refunded'; await this.tickets.save(t); }
    await this.syncIncident(r, 'processing', 'service',
      `客服核准退票 ¥${(r.amount / 100).toFixed(2)}：${note}；流转财务付款`);
    return r;
  }

  /** 客服驳回（游客自身原因且不满足退改规则） */
  async reject(refundId: number, note: string) {
    const r = await this.refunds.findOne({ where: { id: refundId } });
    if (!r) throw new NotFoundException('退票单不存在');
    if (r.status !== 'pending') throw new BadRequestException(`退票单状态 ${r.status}，不可驳回`);
    r.status = 'rejected';
    r.serviceNote = note;
    r.processedAt = now();
    await this.refunds.save(r);
    const t = await this.tickets.findOne({ where: { id: r.ticketId } });
    if (t) { t.status = 'refund_rejected'; await this.tickets.save(t); }
    await this.syncIncident(r, 'resolved', 'service',
      `客服驳回退票：${note}`);
    return r;
  }

  /** 退票争议：升级客服主管（如老人优先争议、责任界定不清、金额异议） */
  async escalate(refundId: number, note: string) {
    const r = await this.refunds.findOne({ where: { id: refundId } });
    if (!r) throw new NotFoundException('退票单不存在');
    if (!['pending', 'rejected'].includes(r.status)) {
      throw new BadRequestException(`退票单状态 ${r.status}，不可升级`);
    }
    r.status = 'escalated';
    r.serviceNote = note;
    await this.refunds.save(r);
    await this.syncIncident(r, 'escalated', 'service',
      `客服无法判定，升级客服主管：${note}`);
    return r;
  }

  /** 客服主管裁决：同意 / 驳回（终局） */
  async supervisorDecide(refundId: number, body: { approve: boolean; note: string }) {
    const r = await this.refunds.findOne({ where: { id: refundId } });
    if (!r) throw new NotFoundException('退票单不存在');
    if (r.status !== 'escalated') throw new BadRequestException('仅升级中的退票单可由主管裁决');
    r.supervisorNote = body.note;
    r.processedAt = now();
    const t = await this.tickets.findOne({ where: { id: r.ticketId } });
    if (body.approve) {
      r.status = 'approved';
      if (t) { t.status = 'refunded'; await this.tickets.save(t); }
      await this.syncIncident(r, 'processing', 'service_supervisor',
        `客服主管裁决同意退票：${body.note}；流转财务付款`);
    } else {
      r.status = 'rejected';
      if (t) { t.status = 'refund_rejected'; await this.tickets.save(t); }
      await this.syncIncident(r, 'resolved', 'service_supervisor',
        `客服主管裁决维持驳回：${body.note}`);
    }
    return this.refunds.save(r);
  }

  /** 财务付款：已核准退票单出账 */
  async pay(refundId: number, note = '原路退回') {
    const r = await this.refunds.findOne({ where: { id: refundId } });
    if (!r) throw new NotFoundException('退票单不存在');
    if (r.status !== 'approved') throw new BadRequestException('仅已核准退票单可付款');
    r.status = 'paid';
    r.paidAt = now();
    if (!r.supervisorNote && note) r.supervisorNote = note;
    await this.refunds.save(r);
    await this.syncIncident(r, 'closed', 'finance', `财务已出账 ¥${(r.amount / 100).toFixed(2)}（${note}）`);
    return r;
  }

  /** 客服领取/流转其他事件（优先争议、误乘、跳站投诉等） */
  async takeIncident(incidentId: number, role: 'service' | 'dispatch' | 'staff') {
    const inc = await this.incidents.findOne({ where: { id: incidentId } });
    if (!inc) throw new NotFoundException('事件不存在');
    const owner = role === 'service' ? 'service' : role;
    inc.status = 'processing';
    inc.ownerRole = owner as any;
    await this.incidents.save(inc);
    return this.incidentSvc.addNote(incidentId, role, '已领取并开始处理');
  }

  private async syncIncident(r: Refund, status: Incident['status'], role: string, text: string) {
    const inc = await this.incidents.findOne({ where: { refundId: r.id } });
    if (inc) {
      inc.status = status;
      await this.incidents.save(inc);
      await this.incidentSvc.addNote(inc.id, role, text);
    }
  }
}
