import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import {
  TransferPlan, TransferOption, Ticket, Trip, Station, RouteLine, Vehicle,
  Driver, Incident, QueueEntry, Refund,
} from '../entities';
import { IncidentsService } from '../incidents/incidents.service';
import { now, seqCode } from '../common';

const ACTIVE_STATUSES: TransferPlan['status'][] = [
  'proposed', 'confirmed', 'accepted', 'completed', 'declined',
];
const DIR_LABEL: Record<string, string> = { forward: '上行', backward: '下行', loop: '环线' };

@Injectable()
export class TransferService {
  constructor(
    @InjectRepository(TransferPlan) private readonly plans: Repository<TransferPlan>,
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(Station) private readonly stations: Repository<Station>,
    @InjectRepository(RouteLine) private readonly routes: Repository<RouteLine>,
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
    @InjectRepository(Driver) private readonly drivers: Repository<Driver>,
    @InjectRepository(Incident) private readonly incidents: Repository<Incident>,
    @InjectRepository(QueueEntry) private readonly queue: Repository<QueueEntry>,
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    private readonly incidentSvc: IncidentsService,
  ) {}

  /* ================= 方案生成（票种 · 当前位置 · 剩余路线） ================= */

  /**
   * 强制放行误乘后（或司机/工作人员在车上发现误乘）生成换乘方案。
   * 平台依据：票种权益、车辆当前位置（下一站）、到目的地的剩余路线。
   */
  async createForWrongBoarding(input: {
    ticketId: number;
    wrongTripId: number;
    boardStationId?: number;
    raisedByRole?: 'staff' | 'driver' | 'dispatch';
    incidentId?: number;
  }): Promise<TransferPlan> {
    const ticket = await this.tickets.findOne({ where: { id: input.ticketId } });
    if (!ticket) throw new NotFoundException('车票不存在');
    const trip = await this.trips.findOne({ where: { id: input.wrongTripId } });
    if (!trip) throw new NotFoundException('班次不存在');

    const existed = await this.plans.findOne({
      where: { ticketId: ticket.id, status: In(ACTIVE_STATUSES) },
    });
    if (existed) throw new BadRequestException('该游客已有进行中的换乘方案，请勿重复生成');

    const routeStations = await this.stations.find({
      where: { routeId: trip.routeId }, order: { seq: 'ASC' },
    });
    const route = await this.routes.findOne({ where: { id: trip.routeId } });
    const wrongVehicle = await this.vehicles.findOne({ where: { id: trip.vehicleId } });

    const boardStationId = input.boardStationId
      ?? wrongVehicle?.currentStationId
      ?? trip.originStationId;
    // 车辆当前所在站的下一站（环线环绕，往返线到终点为止）
    const fromStationId = wrongVehicle?.currentStationId ?? boardStationId;
    const alight = this.nextStation(routeStations, fromStationId, trip.direction, route?.kind || 'loop')
      || routeStations.find(s => s.id === trip.destStationId)
      || routeStations[0];

    // 检票方向以票面 expectedDirection 为准；跨线等兜底按环线最短方向计算
    const neededDirection: 'forward' | 'backward' | 'loop' =
      ticket.expectedDirection === 'forward' || ticket.expectedDirection === 'backward'
        ? ticket.expectedDirection
        : ticket.expectedDirection === 'loop' ? 'loop'
        : this.neededDirection(routeStations, ticket);
    const remainingPath = this.pathNames(routeStations, alight.id, ticket.destStationId, neededDirection);

    // 预取衔接班候选快照（单次生成内复用）
    const [allTrips, allVehicles] = await Promise.all([this.trips.find(), this.vehicles.find()]);
    const { options, connectTrip } = this.buildOptions({
      ticket, route, routeStations, alight, neededDirection, remainingPath,
      allTrips, allVehicles,
    });

    // 误乘事件（串联票 / 误乘班 / 下车站），司机与下一站据此收到提醒
    let incidentId = input.incidentId;
    if (!incidentId) {
      const inc = await this.incidentSvc.create({
        type: 'wrong_direction',
        severity: 'critical',
        title: `${ticket.visitorName} 误乘反方向班车 ${trip.code}，平台生成换乘方案`,
        detail: `游客应乘${DIR_LABEL[neededDirection]}方向前往「${(await this.stationName(ticket.destStationId))}」，`
          + `当前随车向${DIR_LABEL[trip.direction]}方向行驶，安排在「${alight.name}」下车接应换乘`,
        ticketId: ticket.id, tripId: trip.id, stationId: alight.id, vehicleId: trip.vehicleId,
        raisedByRole: input.raisedByRole || 'staff', ownerRole: 'dispatch',
        firstNote: '误乘已发生：平台按票种与剩余路线生成换乘方案，司机与下一站工作人员同步提醒',
      });
      incidentId = inc.id;
    }

    const at = now();
    const plan = await this.plans.save(this.plans.create({
      code: seqCode('HC'),
      ticketId: ticket.id,
      incidentId,
      wrongTripId: trip.id,
      boardStationId,
      currentStationId: fromStationId,
      alightStationId: alight.id,
      transferStationId: null,
      destStationId: ticket.destStationId,
      neededDirection: neededDirection as any,
      options,
      chosenOptionId: '',
      ticketKindNote: this.kindNote(ticket.type),
      status: 'proposed',
      extraWait: false,
      estimatedWaitMinutes: options.find(o => o.recommended)?.estimatedWaitMinutes
        || options[0]?.estimatedWaitMinutes || 0,
      actualWaitMinutes: 0,
      connectTripId: connectTrip?.id || null,
      staffNotifiedAt: at,           // 下一站首次提醒
      timeline: [
        { at, role: 'system', text: `平台生成换乘方案：建议在「${alight.name}」下车，剩余路线 ${remainingPath}` },
        { at, role: 'system', text: `已向班车司机与「${alight.name}」工作人员推送接应提醒（游客不重新排队、不另收车费）` },
      ],
      createdAt: at,
    }));

    await this.incidentSvc.addNote(incidentId, 'system',
      `换乘方案 ${plan.code} 已生成并推送：下车站「${alight.name}」，预计额外等待约 ${plan.estimatedWaitMinutes} 分钟`);
    return this.decorate(plan);
  }

  /** 环线上取最短方向（环线票不限方向） */
  private neededDirection(stations: Station[], ticket: Ticket): 'forward' | 'backward' {
    const o = stations.find(s => s.id === ticket.originStationId);
    const d = stations.find(s => s.id === ticket.destStationId);
    if (!o || !d) return 'forward';
    const n = stations.length;
    const forwardSteps = (d.seq - o.seq + n) % n;
    const backwardSteps = n - forwardSteps;
    return forwardSteps <= backwardSteps ? 'forward' : 'backward';
  }

  private buildOptions(ctx: {
    ticket: Ticket;
    route: RouteLine | null;
    routeStations: Station[];
    alight: Station;
    neededDirection: 'forward' | 'backward' | 'loop';
    remainingPath: string;
    allTrips: Trip[];
    allVehicles: Vehicle[];
  }): { options: TransferOption[]; connectTrip: Trip | null } {
    const { ticket, route, routeStations, alight, neededDirection, remainingPath, allTrips, allVehicles } = ctx;
    const interval = route?.intervalMinutes || 12;

    // 寻找同线路对向可衔接班次（上客中/行驶中/计划班）
    const connect = this.nearestConnectTrip(routeStations, alight, neededDirection, allTrips, allVehicles);
    const connectHint = connect
      ? `可衔接 ${connect.code}（${DIR_LABEL[connect.direction]}，${connect.status === 'boarding' ? '正在上客' : connect.status === 'running' ? '行驶中' : '计划班'}）`
      : `站台将优先安排下一班${DIR_LABEL[neededDirection]}方向车`;
    const baseWait = connect
      ? (connect.status === 'boarding' ? 3 : interval)
      : interval;

    const wheelchairText = ticket.needWheelchair
      ? '已预留轮椅位并安排优先通道，工作人员一对一接应'
      : '优先通道直接上车';
    const partyText = ticket.partySize > 1 ? `，同行 ${ticket.partySize} 人整组不拆散` : '';

    const alightOpt: TransferOption = {
      id: 'alight_transfer',
      kind: 'alight_transfer',
      title: `下一站「${alight.name}」下车，接应换乘${DIR_LABEL[neededDirection]}方向车`,
      detail: `剩余路线：${remainingPath}；${connectHint}；${wheelchairText}${partyText}，无需重新排队、换乘不另收费`,
      alightStationName: alight.name,
      connectDirection: DIR_LABEL[neededDirection],
      connectTripCode: connect?.code,
      estimatedWaitMinutes: baseWait + (ticket.needWheelchair ? 2 : 0),
      extraFare: false,
      recommended: !(ticket.needWheelchair || ticket.partySize >= 4),
    };
    const shuttleOpt: TransferOption = {
      id: 'shuttle',
      kind: 'shuttle',
      title: `调度在「${alight.name}」安排接驳/区间车送回剩余路线`,
      detail: `由调度临时安排区间接驳车，按 ${remainingPath} 送达目的地；`
        + `${ticket.needWheelchair ? '优先安排无障碍接驳车，预留轮椅位' : '适合同行人数较多或不愿再等候班线车的游客'}`,
      alightStationName: alight.name,
      connectDirection: DIR_LABEL[neededDirection],
      estimatedWaitMinutes: baseWait + 10,
      extraFare: false,
      recommended: ticket.needWheelchair || ticket.partySize >= 4,
    };
    const turnaroundOpt: TransferOption = {
      id: 'turnaround',
      kind: 'turnaround',
      title: '随车至前方折返点，原车折返继续乘坐',
      detail: ticket.type === 'loop'
        ? '环线票当日不限乘次，也可选择随车绕回后继续前往目的地，无需下车换乘，但绕行时间更长'
        : '车辆到终点折返后继续搭乘，无需换车但绕行时间较长，单程票不另收费',
      alightStationName: alight.name,
      connectDirection: DIR_LABEL[neededDirection],
      estimatedWaitMinutes: interval * 2 + 10,
      extraFare: false,
      recommended: false,
    };
    const refundOpt: TransferOption = {
      id: 'refund_guide',
      kind: 'refund_guide',
      title: '不接受换乘：工作人员引导客服无责退票',
      detail: '若游客不愿继续行程，下一站工作人员协助发起退票，客服可查看完整行程变化后快速处理',
      alightStationName: alight.name,
      connectDirection: DIR_LABEL[neededDirection],
      estimatedWaitMinutes: 0,
      extraFare: false,
      recommended: false,
    };
    return { options: [alightOpt, shuttleOpt, turnaroundOpt, refundOpt], connectTrip: connect };
  }

  /** 同线路、所需方向、离下车站最近的可衔接班（上客中最优） */
  private nearestConnectTrip(
    stations: Station[], alight: Station,
    neededDirection: 'forward' | 'backward' | 'loop',
    trips: Trip[], vehicles: Vehicle[],
  ): Trip | null {
    const candidates = trips.filter(t =>
      t.routeId === alight.routeId
      && ['boarding', 'running', 'scheduled'].includes(t.status)
      && (neededDirection === 'loop' || t.direction === neededDirection || t.direction === 'loop'));
    if (!candidates.length) return null;
    const boarding = candidates.find(t => t.status === 'boarding');
    if (boarding) return boarding;
    const vMap = new Map(vehicles.map(v => [v.id, v]));
    const n = stations.length;
    const dist = (t: Trip) => {
      const v = vMap.get(t.vehicleId);
      const cur = stations.find(s => s.id === (v?.currentStationId ?? t.originStationId));
      if (!cur) return n;
      if (neededDirection === 'forward') return (alight.seq - cur.seq + n) % n || n;
      if (neededDirection === 'backward') return (cur.seq - alight.seq + n) % n || n;
      return n;
    };
    return candidates.sort((a, b) => dist(a) - dist(b))[0];
  }

  /* ================= 查询（各角色工作台） ================= */

  async list(filter: {
    status?: string; ticketId?: number; tripId?: number; stationId?: number;
  } = {}) {
    const qb = this.plans.createQueryBuilder('p').orderBy('p.id', 'DESC');
    if (filter.status) qb.andWhere('p.status = :s', { s: filter.status });
    if (filter.ticketId) qb.andWhere('p.ticketId = :tid', { tid: filter.ticketId });
    if (filter.tripId) qb.andWhere('p.wrongTripId = :pid', { pid: filter.tripId });
    if (filter.stationId) {
      qb.andWhere('(p.alightStationId = :sid OR p.transferStationId = :sid)', { sid: filter.stationId });
    }
    const rows = await qb.getMany();
    return Promise.all(rows.map(p => this.decorate(p)));
  }

  async get(id: number) {
    const p = await this.plans.findOne({ where: { id } });
    if (!p) throw new NotFoundException('换乘方案不存在');
    return this.decorate(p);
  }

  async forTicket(ticketId: number) {
    const rows = await this.plans.find({
      where: { ticketId }, order: { id: 'DESC' },
    });
    return Promise.all(rows.map(p => this.decorate(p)));
  }

  async decorate(p: TransferPlan) {
    const ticket = await this.tickets.findOne({ where: { id: p.ticketId } });
    const wrongTrip = await this.trips.findOne({ where: { id: p.wrongTripId } });
    const wrongVehicle = wrongTrip
      ? await this.vehicles.findOne({ where: { id: wrongTrip.vehicleId } }) : null;
    const driver = wrongTrip
      ? await this.drivers.findOne({ where: { id: wrongTrip.driverId } }) : null;
    const stationRows = await this.stations.find();
    const sName = (id: number | null | undefined) =>
      stationRows.find(s => s.id === id)?.name || '';
    const incident = await this.incidents.findOne({ where: { id: p.incidentId } });
    const refund = p.refundId
      ? await this.refunds.findOne({ where: { id: p.refundId } }) : null;
    const connectTrip = p.connectTripId
      ? await this.trips.findOne({ where: { id: p.connectTripId } }) : null;
    const connectQueue = p.connectQueueId
      ? await this.queue.findOne({ where: { id: p.connectQueueId } }) : null;
    const chosen = p.options.find(o => o.id === p.chosenOptionId) || null;
    return {
      ...p,
      statusLabel: this.statusLabel(p.status),
      ticket: ticket ? {
        id: ticket.id, code: ticket.code, type: ticket.type,
        visitorName: ticket.visitorName, partySize: ticket.partySize,
        priority: ticket.priority, needWheelchair: ticket.needWheelchair,
        hasElder: ticket.hasElder, hasChild: ticket.hasChild, hasStroller: ticket.hasStroller,
        status: ticket.status, price: ticket.price,
      } : null,
      wrongTrip: wrongTrip ? {
        id: wrongTrip.id, code: wrongTrip.code, direction: wrongTrip.direction,
        status: wrongTrip.status,
      } : null,
      wrongVehicleCode: wrongVehicle?.code || '',
      driverName: driver?.name || '',
      boardStationName: sName(p.boardStationId),
      alightStationName: sName(p.alightStationId),
      transferStationName: sName(p.transferStationId),
      destStationName: sName(p.destStationId),
      currentStationName: sName(p.currentStationId),
      connectTrip: connectTrip ? {
        id: connectTrip.id, code: connectTrip.code, direction: connectTrip.direction,
        status: connectTrip.status,
      } : null,
      connectQueueStatus: connectQueue?.status || null,
      chosenOption: chosen,
      incident: incident ? {
        id: incident.id, code: incident.code, status: incident.status,
        title: incident.title, detail: incident.detail,
      } : null,
      refund: refund ? {
        id: refund.id, code: refund.code, status: refund.status, amount: refund.amount,
      } : null,
    };
  }

  /* ================= 方案确认（调度/站务） ================= */

  async confirm(id: number, body: {
    optionId: string;
    connectTripId?: number | null;
    transferStationId?: number | null;
    note?: string;
    byRole?: 'dispatch' | 'staff';
  }) {
    const plan = await this.plans.findOne({ where: { id } });
    if (!plan) throw new NotFoundException('换乘方案不存在');
    if (['archived', 'cancelled', 'accepted', 'completed'].includes(plan.status)) {
      throw new BadRequestException(`方案当前「${this.statusLabel(plan.status)}」，不可再确认`);
    }
    if (plan.status === 'declined' && plan.refundId) {
      throw new BadRequestException('方案已转入退票流程，不可再改回换乘');
    }
    const option = plan.options.find(o => o.id === body.optionId);
    if (!option) throw new BadRequestException('选择的换乘方案选项不存在');

    if (option.id === 'refund_guide') {
      plan.chosenOptionId = option.id;
      plan.status = 'confirmed';
      plan.staffRemindedAt = now();
      plan.visitorSyncedAt = now();
      await this.addTimeline(plan, body.byRole || 'dispatch',
        `已确认按「${option.title}」执行：下一站工作人员将引导游客联系客服退票`);
      return this.get(id);
    }

    let connectTrip: Trip | null = null;
    if (body.connectTripId) {
      connectTrip = await this.trips.findOne({ where: { id: body.connectTripId } });
      if (!connectTrip) throw new NotFoundException('衔接班次不存在');
    } else if (plan.connectTripId) {
      connectTrip = await this.trips.findOne({ where: { id: plan.connectTripId } });
    }
    const transferStationId = body.transferStationId || plan.alightStationId;

    const wasDeclined = plan.status === 'declined';
    plan.chosenOptionId = option.id;
    plan.connectTripId = connectTrip?.id || null;
    plan.transferStationId = transferStationId;
    plan.estimatedWaitMinutes = option.estimatedWaitMinutes;
    // 游客此前拒绝、经工作人员沟通后改主意继续行程 → 直接视为已接受
    plan.status = wasDeclined ? 'accepted' : 'confirmed';
    if (wasDeclined) plan.declineReason = '';
    plan.staffRemindedAt = now();    // 方案确认后，下一站同步提醒
    plan.visitorSyncedAt = now();    // 行程变化同步游客端
    await this.plans.save(plan);

    const sName = (await this.stations.findOne({ where: { id: transferStationId } }))?.name || '';
    await this.addTimeline(plan, body.byRole || 'dispatch',
      `已${wasDeclined ? '重新' : ''}确认换乘方案「${option.title}」；衔接 ${connectTrip?.code || '下一班对向车'}，`
      + `「${sName}」工作人员收到接应提醒，预计额外等待约 ${option.estimatedWaitMinutes} 分钟`);
    await this.incidentSvc.addNote(plan.incidentId, body.byRole || 'dispatch',
      wasDeclined
        ? '游客改主意继续行程，工作人员重新安排换乘并同步各方'
        : '方案已确认并同步：游客端收到行程变化通知，下一站再次提醒，工作人员接应免排队');
    return this.get(id);
  }

  /* ================= 司机端 ================= */

  async driverAck(id: number) {
    const plan = await this.plans.findOne({ where: { id } });
    if (!plan) throw new NotFoundException('换乘方案不存在');
    if (!plan.driverAckAt) {
      plan.driverAckAt = now();
      await this.plans.save(plan);
      await this.addTimeline(plan, 'driver', '司机已知悉：到站提醒该游客在本站下车，并交接到接应工作人员');
    }
    return this.get(id);
  }

  /* ================= 下一站工作人员接应 ================= */

  /** 到站接应登记：不要求游客重新排队，直接生成优先交接队列 */
  async staffMeet(id: number, body: { note?: string; actualWaitMinutes?: number } = {}) {
    const plan = await this.plans.findOne({ where: { id } });
    if (!plan) throw new NotFoundException('换乘方案不存在');
    if (plan.staffMetAt) throw new BadRequestException('本站已完成接应登记');
    if (!['confirmed', 'accepted', 'completed'].includes(plan.status)) {
      throw new BadRequestException('换乘方案尚未确认，请先由调度/站务确认方案后再接应');
    }
    const ticket = await this.tickets.findOne({ where: { id: plan.ticketId } });
    if (!ticket) throw new NotFoundException('车票不存在');

    const stationId = plan.transferStationId || plan.alightStationId;
    plan.staffMetAt = now();
    plan.transferStationId = stationId;
    plan.currentStationId = stationId;
    if (body.actualWaitMinutes && body.actualWaitMinutes > 0) {
      plan.actualWaitMinutes = body.actualWaitMinutes;
      plan.extraWait = true;
    }
    await this.plans.save(plan);

    // 选择换乘类方案：直接以「已叫号」状态进入交接队列，游客无需重新排队
    const option = plan.options.find(o => o.id === plan.chosenOptionId);
    let entry: QueueEntry | null = null;
    let stayOnBoard = false;
    if (option && ['alight_transfer', 'shuttle'].includes(option.kind)) {
      entry = await this.queue.save(this.queue.create({
        stationId,
        ticketId: ticket.id,
        partySize: ticket.partySize,
        priority: true,
        expectedDirection: plan.neededDirection,
        status: 'called',
        enqueueAt: now(),
        tripId: plan.connectTripId,
        transferPlanId: plan.id,
      }));
      plan.connectQueueId = entry.id;
      ticket.status = 'queued';
      await this.tickets.save(ticket);
      await this.plans.save(plan);
    } else if (option?.kind === 'turnaround') {
      // 原车折返：游客不下车换乘，由司机/工作人员安抚后随车继续，方案直接完成
      stayOnBoard = true;
      plan.completedAt = now();
      plan.status = 'completed';
      if (!plan.actualWaitMinutes) plan.actualWaitMinutes = option.estimatedWaitMinutes;
      plan.extraWait = plan.actualWaitMinutes > 0;
      await this.plans.save(plan);
    }

    const station = await this.stations.findOne({ where: { id: stationId } });
    await this.addTimeline(plan, 'staff',
      `「${station?.name}」工作人员已接到游客`
      + `${entry ? '，经优先通道直接安排换乘（未重新排队）' : stayOnBoard ? '，已安抚并引导原车折返继续乘坐（无需下车换乘）' : ''}`
      + `${body.note ? `：${body.note}` : ''}`);
    if (stayOnBoard) {
      await this.incidentSvc.addNote(plan.incidentId, 'system',
        `游客选择原车折返方案，无需换乘，等待游客确认后归档`);
    }
    return this.get(id);
  }

  async staffNote(id: number, note: string) {
    const plan = await this.plans.findOne({ where: { id } });
    if (!plan) throw new NotFoundException('换乘方案不存在');
    plan.staffNote = note;
    await this.plans.save(plan);
    await this.addTimeline(plan, 'staff', note);
    return this.get(id);
  }

  /* ================= 游客端：接受 / 拒绝 / 行程同步 ================= */

  async visitorDecide(id: number, body: { accept: boolean; reason?: string }) {
    const plan = await this.plans.findOne({ where: { id } });
    if (!plan) throw new NotFoundException('换乘方案不存在');
    if (plan.visitorDecidedAt) throw new BadRequestException('游客已做过选择，请勿重复提交');
    if (!['confirmed', 'proposed', 'accepted'].includes(plan.status)) {
      throw new BadRequestException(`方案当前「${this.statusLabel(plan.status)}」，暂不能选择`);
    }
    plan.visitorDecidedAt = now();
    const chosenKind = plan.options.find(o => o.id === plan.chosenOptionId)?.kind;
    if (body.accept) {
      // 接受的若是「退票引导」方案 → 直接代为发起退票
      if (chosenKind === 'refund_guide') {
        await this.plans.save(plan);
        await this.addTimeline(plan, 'visitor', '游客接受退票引导，工作人员代为发起退票');
        return this.requestRefund(id, {
          reason: body.reason || '误乘反方向，游客按平台引导申请退票',
        });
      }
      plan.status = plan.status === 'completed' ? 'completed' : 'accepted';
      await this.plans.save(plan);
      await this.addTimeline(plan, 'visitor', '游客已接受换乘方案，行程变化已同步至游客端');
    } else {
      plan.status = 'declined';
      plan.declineReason = body.reason || '游客不接受换乘方案';
      await this.plans.save(plan);
      await this.addTimeline(plan, 'visitor',
        `游客不接受换乘方案：${plan.declineReason}；工作人员将引导客服退票处理`);
      await this.incidentSvc.addNote(plan.incidentId, 'visitor',
        `游客拒绝换乘（${plan.declineReason}），等待客服退票处理`);
    }
    return this.get(id);
  }

  /** 游客拒绝/对行程仍有异议 → 直接进入客服退票（已上车票的特殊通道） */
  async requestRefund(id: number, body: { reason?: string; faultTag?: Refund['faultTag'] } = {}) {
    const plan = await this.plans.findOne({ where: { id } });
    if (!plan) throw new NotFoundException('换乘方案不存在');
    if (plan.refundId) throw new BadRequestException('该方案已关联退票单');
    const ticket = await this.tickets.findOne({ where: { id: plan.ticketId } });
    if (!ticket) throw new NotFoundException('车票不存在');

    const refund = await this.refunds.save(this.refunds.create({
      code: seqCode('RF'),
      ticketId: ticket.id,
      amount: ticket.price,
      reason: body.reason || '误乘反方向，游客不接受换乘/行程受影响，申请退票',
      faultTag: body.faultTag || 'schedule',
      applicantRole: 'staff',
      status: 'pending',
      serviceNote: '',
      createdAt: now(),
    }));
    plan.refundId = refund.id;
    if (plan.status !== 'declined') {
      plan.status = 'declined';
      plan.declineReason = body.reason || plan.declineReason || '游客选择退票';
      plan.visitorDecidedAt = plan.visitorDecidedAt || now();
    }
    await this.plans.save(plan);
    ticket.status = 'refund_pending';
    await this.tickets.save(ticket);

    await this.incidentSvc.create({
      type: 'refund_request',
      severity: 'critical',
      title: `误乘退票：${ticket.visitorName}（¥${(ticket.price / 100).toFixed(2)}）`,
      detail: `关联换乘方案 ${plan.code}：${body.reason || '游客误乘反方向后申请退票'}，客服可查看完整行程变化`,
      ticketId: ticket.id, tripId: plan.wrongTripId, refundId: refund.id,
      raisedByRole: 'staff', ownerRole: 'service',
      firstNote: '误乘换乘链路转入退票，请客服结合行程时间线判定（平台责任建议无责全额）',
    });
    await this.addTimeline(plan, 'staff', `已代为发起退票 RF 单，流转客服处理`);
    return this.get(id);
  }

  /* ================= 完成与归档 ================= */

  /** 游客凭优先交接队列检上对向车后调用（由检票流程触发） */
  async onTransferBoarded(planId: number, connectTripId: number) {
    const plan = await this.plans.findOne({ where: { id: planId } });
    if (!plan) return;
    if (['archived', 'cancelled'].includes(plan.status)) return;
    const trip = await this.trips.findOne({ where: { id: connectTripId } });
    plan.connectTripId = connectTripId;
    plan.completedAt = now();
    plan.currentStationId = plan.transferStationId || plan.alightStationId;
    if (!plan.actualWaitMinutes) {
      plan.actualWaitMinutes = plan.estimatedWaitMinutes;
    }
    plan.extraWait = plan.actualWaitMinutes > 0;
    plan.status = 'completed';
    await this.plans.save(plan);
    await this.addTimeline(plan, 'system',
      `游客已检上 ${trip?.code || '衔接班车'}，换乘完成，实际额外等待约 ${plan.actualWaitMinutes} 分钟`);
    await this.incidentSvc.addNote(plan.incidentId, 'system',
      `换乘完成：未重新排队，额外等待 ${plan.actualWaitMinutes} 分钟，等待游客确认后归档`);
  }

  /** 游客确认后归档（客服/工作人员也可代为确认） */
  async archive(id: number, body: { byRole?: 'visitor' | 'staff' | 'service' } = {}) {
    const plan = await this.plans.findOne({ where: { id } });
    if (!plan) throw new NotFoundException('换乘方案不存在');
    if (plan.status === 'archived') throw new BadRequestException('方案已归档');
    const refundDone = !plan.refundId
      || (await this.refunds.findOne({ where: { id: plan.refundId } }))?.status === 'paid';
    const journeyDone = plan.status === 'completed' || plan.status === 'declined';
    if (!journeyDone) {
      throw new BadRequestException('换乘尚未完成且游客未拒绝，暂不能归档');
    }
    if (!refundDone) {
      throw new BadRequestException('关联退票单尚未出账完成，暂不能归档');
    }
    const wasDeclined = plan.status === 'declined' || !!plan.refundId;
    plan.status = 'archived';
    plan.archivedAt = now();
    await this.plans.save(plan);

    const ticket = await this.tickets.findOne({ where: { id: plan.ticketId } });
    const summary = wasDeclined
      ? `误乘行程已闭环：游客选择退票/方案结束，方案 ${plan.code} 归档`
      : `误乘换乘已闭环：游客确认行程，方案 ${plan.code} 归档（额外等待 ${plan.actualWaitMinutes} 分钟）`;
    await this.addTimeline(plan, body.byRole || 'visitor', '游客确认行程变化，方案归档');
    await this.incidentSvc.update(plan.incidentId, {
      status: 'closed',
      resolution: summary + (ticket ? `（票 ${ticket.code}）` : ''),
    }, { role: body.byRole || 'visitor', text: '游客确认后归档，误乘换乘事件闭环' });
    return this.get(id);
  }

  async cancel(id: number, reason: string) {
    const plan = await this.plans.findOne({ where: { id } });
    if (!plan) throw new NotFoundException('换乘方案不存在');
    plan.status = 'cancelled';
    await this.plans.save(plan);
    await this.addTimeline(plan, 'dispatch', `方案作废：${reason}`);
    return this.get(id);
  }

  /* ================= 复盘统计 ================= */

  async stats() {
    const rows = await this.plans.find();
    const count = (s: TransferPlan['status']) => rows.filter(p => p.status === s).length;
    const done = rows.filter(p => p.status === 'completed' || p.status === 'archived');
    const waits = done.map(p => p.actualWaitMinutes).filter(w => w > 0);
    return {
      total: rows.length,
      active: rows.filter(p => ACTIVE_STATUSES.includes(p.status) && p.status !== 'archived').length,
      proposed: count('proposed'),
      confirmed: count('confirmed'),
      accepted: count('accepted'),
      completed: count('completed'),
      declined: count('declined'),
      archived: count('archived'),
      extraWaitCount: rows.filter(p => p.extraWait).length,
      refundLinked: rows.filter(p => !!p.refundId).length,
      avgActualWaitMinutes: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0,
    };
  }

  /**
   * 误乘班完班时，需要在其他班次换乘（alight_transfer/shuttle）且方案
   * 尚未归档的票不应被误乘班核销；原车折返（turnaround）的票随车继续，正常核销。
   */
  async activeTicketIdsOnTrip(tripId: number): Promise<Set<number>> {
    const rows = await this.plans.find({
      where: { wrongTripId: tripId, status: Not(In(['archived', 'cancelled'])) },
    });
    return new Set(
      rows
        .filter(p => {
          const kind = p.options.find(o => o.id === p.chosenOptionId)?.kind;
          // 仅明确选择「原车折返」的票随误乘班核销；其余（待确认/换乘/接驳/退票）挂起
          return kind !== 'turnaround';
        })
        .map(p => p.ticketId),
    );
  }

  /* ================= 内部工具 ================= */

  private async addTimeline(plan: TransferPlan, role: string, text: string) {
    const tl = plan.timeline || [];
    tl.push({ at: now(), role, text });
    plan.timeline = tl;
    await this.plans.save(plan);
  }

  private nextStation(stations: Station[], fromId: number, dir: string, kind: string): Station | null {
    const idx = stations.findIndex(s => s.id === fromId);
    if (idx < 0) return null;
    if (dir === 'backward') {
      if (idx === 0) return kind === 'loop' ? stations[stations.length - 1] : null;
      return stations[idx - 1];
    }
    if (idx === stations.length - 1) return kind === 'loop' ? stations[0] : null;
    return stations[idx + 1];
  }

  /** 沿指定方向从 from 到 dest 经过的站名（含 dest） */
  private pathNames(stations: Station[], fromId: number, destId: number, dir: 'forward' | 'backward' | 'loop'): string {
    const n = stations.length;
    const cur = stations.find(s => s.id === fromId);
    const dest = stations.find(s => s.id === destId);
    if (!cur || !dest) return '';
    if (cur.seq === dest.seq) return '（已在目的地）';
    const names: string[] = [];
    let seq = cur.seq;
    const step = dir === 'backward' ? -1 : 1;
    for (let i = 0; i < n * 2; i++) {
      if (dir === 'backward') seq = ((seq - 2 + n) % n) + 1;
      else seq = ((seq) % n) + 1;
      const s = stations.find(x => x.seq === seq);
      if (s) names.push(s.name);
      if (seq === dest.seq) break;
    }
    return names.join(' → ') || dest.name;
  }

  private async stationName(id: number) {
    return (await this.stations.findOne({ where: { id } }))?.name || `#${id}`;
  }

  private kindNote(type: Ticket['type']): string {
    return ({
      single: '单程票：换乘不另收车费；若误乘导致行程无法继续，可申请无责退票',
      loop: '环线票：当日不限乘次，任意对向班车均可换乘，无需补差价',
      parent_child: '亲子票：同行儿童/婴儿车整组安排，优先座位不拆散',
      accessible_priority: '无障碍优先票：预留轮椅位、优先通道，工作人员一对一接应，不重新排队',
    } as Record<string, string>)[type] || '';
  }

  statusLabel(s: TransferPlan['status']) {
    return ({
      proposed: '待确认', confirmed: '已确认待接应', accepted: '游客已接受',
      completed: '换乘完成', declined: '游客已拒绝', archived: '已归档', cancelled: '已作废',
    } as Record<string, string>)[s] || s;
  }
}
