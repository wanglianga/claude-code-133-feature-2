import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  WrongBoardingTransfer, TransferStep, Ticket, Trip, Vehicle, Driver,
  Station, RouteLine, Incident,
} from '../entities';
import { IncidentsService } from '../incidents/incidents.service';
import { now, seqCode } from '../common';

type Dir = 'forward' | 'backward' | 'loop';

@Injectable()
export class TransfersService {
  constructor(
    @InjectRepository(WrongBoardingTransfer) private readonly repo: Repository<WrongBoardingTransfer>,
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(Vehicle) private readonly vehicles: Repository<Vehicle>,
    @InjectRepository(Driver) private readonly drivers: Repository<Driver>,
    @InjectRepository(Station) private readonly stations: Repository<Station>,
    @InjectRepository(RouteLine) private readonly routes: Repository<RouteLine>,
    @InjectRepository(Incident) private readonly incidentRepo: Repository<Incident>,
    private readonly incidentSvc: IncidentsService,
  ) {}

  /* ================= 生成换乘方案 ================= */

  /**
   * 游客误上反方向车辆：平台根据票种、当前位置、剩余路线生成换乘方案，
   * 并向司机与下一站工作人员发出提醒（不要求游客重新排队）。
   */
  async createPlan(input: {
    ticketId: number;
    wrongTripId: number;
    boardStationId?: number;
    currentStationId?: number;
    raisedByRole?: 'staff' | 'driver' | 'dispatch' | 'system';
  }): Promise<WrongBoardingTransfer> {
    const ticket = await this.tickets.findOne({ where: { id: input.ticketId } });
    if (!ticket) throw new NotFoundException('车票不存在');
    const trip = await this.trips.findOne({ where: { id: input.wrongTripId } });
    if (!trip) throw new NotFoundException('班次不存在');

    const exist = await this.repo.findOne({
      where: { ticketId: ticket.id, status: In(['proposed', 'accepted']) },
    });
    if (exist) throw new BadRequestException('该票已有进行中的换乘方案，请勿重复生成');

    const [route, vehicle, driver, routeStationsRaw] = await Promise.all([
      this.routes.findOne({ where: { id: trip.routeId } }),
      this.vehicles.findOne({ where: { id: trip.vehicleId } }),
      this.drivers.findOne({ where: { id: trip.driverId } }),
      this.stations.find({ where: { routeId: trip.routeId }, order: { seq: 'ASC' } }),
    ]);
    if (!vehicle || !driver) throw new NotFoundException('车辆或司机不存在');
    const routeStations = routeStationsRaw;

    const boardStationId = input.boardStationId
      || ticket.originStationId;
    const currentStationId = input.currentStationId
      || vehicle.currentStationId
      || boardStationId;

    // 本班（错误方向）的下一站：游客在此下车
    const alightStation = this.nextStationAlong(
      routeStations, currentStationId, trip.direction as Dir, !!route?.kind.includes('loop'),
    ) || this.stationById(routeStations, boardStationId);
    if (!alightStation) throw new BadRequestException('无法确定下车站：车辆已到本方向末站，请司机直接折返');

    // 接驳方向 = 误乘方向的反方向（环线班按起终点 seq 推断）
    const pickupDir: Dir = trip.direction === 'forward' ? 'backward'
      : trip.direction === 'backward' ? 'forward'
      : (alightStation.seq < (this.stationById(routeStations, ticket.destStationId)?.seq || 0)
        ? 'forward' : 'backward');

    const destStation = this.stationById(routeStations, ticket.destStationId)
      || await this.stations.findOne({ where: { id: ticket.destStationId } });

    // 自动寻找可接应的对向在运/计划班
    const candidateTrips = await this.trips.find({
      where: { routeId: trip.routeId, status: In(['boarding', 'running', 'scheduled']) },
      order: { id: 'ASC' },
    });
    const pickupTrip = this.matchPickupTrip(
      candidateTrips, routeStations, alightStation.id, ticket.destStationId, pickupDir,
    );

    const interval = route?.intervalMinutes || 12;
    // 额外等待估算：已有可接应班次约等半个发车间隔；无现成班次需等调度加开，按 2 个间隔估
    const extraWaitMinutes = pickupTrip ? Math.round(interval / 2) : interval * 2;
    const causedExtraWait = extraWaitMinutes > 0;

    const planSteps = this.buildSteps({
      ticket, alightName: alightStation.name, destName: destStation?.name || '目的地',
      pickupDir, pickupTripCode: pickupTrip?.code || '', needWheelchair: ticket.needWheelchair,
    });
    const remainingRouteText = this.remainingText(
      routeStations, alightStation.id, ticket.destStationId, pickupDir,
      !!route?.kind.includes('loop'),
    );

    const at = now();
    const incident = await this.incidentSvc.create({
      type: 'wrong_direction',
      severity: 'critical',
      title: `${ticket.visitorName} 误上反方向班车 ${trip.code}，平台已生成换乘方案`,
      detail:
        `误乘 ${this.dirLabel(trip.direction as Dir)}班车（${vehicle.code}/${driver.name}），` +
        `当前位置 ${this.nameOf(routeStations, currentStationId)}，` +
        `请在前方「${alightStation.name}」下车，由站务引导换乘${this.dirLabel(pickupDir)}接驳车前往「${destStation?.name}」；` +
        `预计额外等待约 ${extraWaitMinutes} 分钟，游客无需重新排队。`,
      ticketId: ticket.id, tripId: trip.id, stationId: boardStationId, vehicleId: vehicle.id,
      raisedByRole: input.raisedByRole || 'staff', ownerRole: 'dispatch',
      firstNote: `检票口确认误乘反方向，平台按${this.typeName(ticket.type)}与剩余路线「${remainingRouteText}」生成换乘方案`,
    });

    const row = this.repo.create({
      code: seqCode('WB'),
      ticketId: ticket.id,
      incidentId: incident.id,
      wrongTripId: trip.id,
      vehicleId: vehicle.id,
      driverId: driver.id,
      routeId: trip.routeId,
      boardStationId,
      currentStationId,
      alightStationId: alightStation.id,
      destStationId: ticket.destStationId,
      transferTripId: pickupTrip?.id || null,
      ticketType: ticket.type,
      partySize: ticket.partySize,
      needWheelchair: ticket.needWheelchair,
      priority: ticket.priority,
      remainingRouteText,
      planSteps,
      status: 'proposed',
      extraWaitMinutes,
      actualExtraWaitMinutes: 0,
      causedExtraWait,
      remindedDriverAt: at,
      remindedNextStationAt: at,
      createdAt: at,
    });
    const saved = await this.repo.save(row);

    // 同步提醒：司机 + 下一站工作人员
    await this.incidentSvc.addNote(incident.id, 'system',
      `已向司机 ${driver.name}（${vehicle.code}）发送车上提醒：安抚游客、勿让其下车折返或重新排队，到达「${alightStation.name}」时交由站务接应`);
    await this.incidentSvc.addNote(incident.id, 'system',
      `已向下一站「${alightStation.name}」工作人员发送接应提醒：${ticket.partySize} 人${ticket.needWheelchair ? '（含轮椅，需轮椅位）' : ''}将于本班到店，请在车门接应并引导至对向站台优先通道，免重新排队`);
    if (pickupTrip) {
      await this.incidentSvc.addNote(incident.id, 'dispatch',
        `系统已匹配接驳班次 ${pickupTrip.code}（${this.dirLabel(pickupDir)}），请该车预留 ${ticket.partySize} 个座位${ticket.needWheelchair ? '与 1 个轮椅位' : ''}`);
    } else {
      await this.incidentSvc.addNote(incident.id, 'dispatch',
        `暂无可接应的${this.dirLabel(pickupDir)}班次，调度需安排/加开接驳车在「${alightStation.name}」接回，预计额外等待约 ${extraWaitMinutes} 分钟`);
    }
    return saved;
  }

  /* ================= 游客接受 / 拒绝 ================= */

  async accept(id: number, note = '') {
    const tr = await this.require(id, ['proposed']);
    tr.status = 'accepted';
    tr.acceptedAt = now();
    if (note) tr.visitorNote = note;
    await this.repo.save(tr);
    const t = await this.tickets.findOne({ where: { id: tr.ticketId } });
    await this.incidentSvc.addNote(tr.incidentId, 'visitor',
      `游客已接受换乘方案：在「${await this.stationName(tr.alightStationId)}」下车换乘，行程变化已同步游客端${note ? `；备注：${note}` : ''}`);
    await this.incidentSvc.addNote(tr.incidentId, 'dispatch',
      `方案确认生效：接驳安排保持不变，司机与下一站按提醒执行；${t?.visitorName || '游客'}一行 ${tr.partySize} 人`);
    return this.detail(id);
  }

  async decline(id: number, reason: string) {
    const tr = await this.require(id, ['proposed']);
    tr.status = 'declined';
    tr.declinedAt = now();
    tr.visitorNote = reason;
    await this.repo.save(tr);
    await this.incidentSvc.addNote(tr.incidentId, 'visitor',
      `游客不接受换乘方案：${reason || '未填写原因'}；客服可按误乘场景继续提供退改签协助`);
    return this.detail(id);
  }

  /* ================= 司机 / 下一站响应提醒 ================= */

  async driverAck(id: number) {
    const tr = await this.require(id, ['proposed', 'accepted']);
    if (!tr.driverAckAt) tr.driverAckAt = now();
    await this.repo.save(tr);
    await this.incidentSvc.addNote(tr.incidentId, 'driver',
      '司机已确认收到提醒：会安抚游客并在下一站移交站务，不要求游客重新排队');
    return this.detail(id);
  }

  async stationAck(id: number, note = '') {
    const tr = await this.require(id, ['proposed', 'accepted']);
    if (!tr.nextStationAckAt) tr.nextStationAckAt = now();
    if (note) tr.staffNote = note;
    await this.repo.save(tr);
    await this.incidentSvc.addNote(tr.incidentId, 'staff',
      `下一站工作人员已确认收到接应提醒，将在车门接应并开放优先通道${note ? `；现场备注：${note}` : ''}`);
    return this.detail(id);
  }

  /* ================= 调度锁定接驳班 ================= */

  async assignPickup(id: number, tripId: number, note = '') {
    const tr = await this.require(id, ['proposed', 'accepted']);
    const pickup = await this.trips.findOne({ where: { id: tripId } });
    if (!pickup) throw new NotFoundException('接驳班次不存在');
    if (pickup.routeId !== tr.routeId) throw new BadRequestException('接驳班次必须与原线路一致');
    const stations = await this.stations.find({ where: { routeId: tr.routeId }, order: { seq: 'ASC' } });
    const expectedDir = this.pickupDirectionOf(tr, stations);
    if (pickup.direction !== 'loop' && pickup.direction !== expectedDir) {
      throw new BadRequestException(`接驳班次方向不符，需 ${this.dirLabel(expectedDir)} 方向`);
    }
    if (!this.tripCovers(pickup, stations, tr.alightStationId)) {
      throw new BadRequestException('该班次不经过下车站，无法接应');
    }
    tr.transferTripId = pickup.id;
    tr.extraWaitMinutes = Math.max(0, Math.round((pickup.departAt
      ? (new Date(pickup.departAt).getTime() - Date.now()) / 60000 : 0))) || tr.extraWaitMinutes;
    tr.causedExtraWait = true;
    if (note) tr.dispatchNote = note;
    await this.repo.save(tr);

    const ticket = await this.tickets.findOne({ where: { id: tr.ticketId } });
    const alightName = await this.stationName(tr.alightStationId);
    await this.incidentSvc.addNote(tr.incidentId, 'dispatch',
      `调度已锁定接驳班次 ${pickup.code}（${this.dirLabel(pickup.direction as Dir)}）在「${alightName}」接应 ${ticket?.visitorName || '游客'}一行 ${tr.partySize} 人`
      + `${tr.needWheelchair ? '，预留 1 个轮椅位' : ''}${note ? `；${note}` : ''}`);
    return this.detail(id);
  }

  /* ================= 车辆抵达下车站 / 完成换乘 / 归档 ================= */

  /** 车辆电子围栏到站时自动联动 */
  async onVehicleArrive(wrongTripId: number, stationId: number) {
    const rows = await this.repo.find({
      where: { wrongTripId, alightStationId: stationId, status: In(['proposed', 'accepted']) },
    });
    for (const tr of rows) {
      if (!tr.alightArrivedAt) tr.alightArrivedAt = now();
      tr.currentStationId = stationId;
      await this.repo.save(tr);
      await this.incidentSvc.addNote(tr.incidentId, 'system',
        `车辆已抵达下车站「${await this.stationName(stationId)}」，站务请上车/车门接应游客下车换乘`);
    }
    return rows.length;
  }

  async complete(id: number, body: { actualExtraWaitMinutes?: number; note?: string } = {}) {
    const tr = await this.require(id, ['accepted', 'proposed']);
    tr.status = 'completed';
    tr.completedAt = now();
    const measured = Math.max(0, Math.round((Date.now() - new Date(tr.createdAt).getTime()) / 60000));
    tr.actualExtraWaitMinutes = body.actualExtraWaitMinutes ?? Math.max(measured, tr.extraWaitMinutes);
    tr.causedExtraWait = tr.actualExtraWaitMinutes > 0;
    if (body.note) tr.staffNote = body.note;
    // 车票关联到接驳班次（若已锁定），完班时随接驳班核销
    if (tr.transferTripId) {
      const ticket = await this.tickets.findOne({ where: { id: tr.ticketId } });
      if (ticket) { ticket.tripId = tr.transferTripId; await this.tickets.save(ticket); }
    }
    await this.repo.save(tr);
    const ticket = await this.tickets.findOne({ where: { id: tr.ticketId } });
    await this.incidentSvc.addNote(tr.incidentId, 'staff',
      `下一站确认：${ticket?.visitorName || '游客'}一行已在「${await this.stationName(tr.alightStationId)}」下车并由对向站台接走，无需重新排队`
      + `；实际额外等待约 ${tr.actualExtraWaitMinutes} 分钟（${tr.causedExtraWait ? '已产生额外等待' : '未产生额外等待'}），等待游客端确认后归档`);
    return this.detail(id);
  }

  /** 游客确认后归档 */
  async archive(id: number, note = '') {
    const tr = await this.require(id, ['completed', 'declined']);
    tr.status = 'archived';
    tr.archivedAt = now();
    if (note) tr.visitorNote = [tr.visitorNote, note].filter(Boolean).join('｜');
    await this.repo.save(tr);
    await this.incidentSvc.update(tr.incidentId, { status: 'closed', resolution: '换乘方案已归档' },
      { role: 'visitor', text: `游客已确认行程变化并归档方案 ${tr.code}${note ? `：${note}` : ''}` });
    return this.detail(id);
  }

  /* ================= 查询 ================= */

  async list(filter: { status?: string; ticketId?: number; driverId?: number; stationId?: number } = {}) {
    const rows = await this.repo.find({ order: { id: 'DESC' } });
    const decorated = await Promise.all(rows.map(r => this.decorate(r)));
    return decorated.filter(r => {
      if (filter.status && r.status !== filter.status) return false;
      if (filter.ticketId && r.ticketId !== Number(filter.ticketId)) return false;
      if (filter.driverId && r.driverId !== Number(filter.driverId)) return false;
      if (filter.stationId && r.alightStationId !== Number(filter.stationId)
        && r.boardStationId !== Number(filter.stationId)
        && r.currentStationId !== Number(filter.stationId)) return false;
      return true;
    });
  }

  async byTicket(ticketId: number) {
    const rows = await this.repo.find({ where: { ticketId }, order: { id: 'DESC' } });
    return Promise.all(rows.map(r => this.decorate(r)));
  }

  async detail(id: number) {
    const tr = await this.require(id);
    return this.decorate(tr);
  }

  /** 客服退票审核视角：该票完整行程变化 */
  async ticketJourney(ticketId: number) {
    const rows = await this.repo.find({ where: { ticketId }, order: { id: 'ASC' } });
    return Promise.all(rows.map(r => this.decorate(r)));
  }

  async getRaw(id: number) {
    return this.repo.findOne({ where: { id } });
  }

  /* ================= 内部工具 ================= */

  private async decorate(tr: WrongBoardingTransfer) {
    const [ticket, wrongTrip, pickupTrip, vehicle, driver, board, current, alight, dest, incident] =
      await Promise.all([
        this.tickets.findOne({ where: { id: tr.ticketId } }),
        this.trips.findOne({ where: { id: tr.wrongTripId } }),
        tr.transferTripId ? this.trips.findOne({ where: { id: tr.transferTripId } }) : Promise.resolve(null),
        this.vehicles.findOne({ where: { id: tr.vehicleId } }),
        this.drivers.findOne({ where: { id: tr.driverId } }),
        this.stations.findOne({ where: { id: tr.boardStationId } }),
        this.stations.findOne({ where: { id: tr.currentStationId } }),
        this.stations.findOne({ where: { id: tr.alightStationId } }),
        this.stations.findOne({ where: { id: tr.destStationId } }),
        this.incidentRepo.findOne({ where: { id: tr.incidentId } }),
      ]);
    return {
      ...tr,
      ticket: ticket ? {
        id: ticket.id, code: ticket.code, visitorName: ticket.visitorName,
        partySize: ticket.partySize, type: ticket.type, phone: ticket.phone,
        needWheelchair: ticket.needWheelchair, priority: ticket.priority,
        status: ticket.status, price: ticket.price,
      } : null,
      wrongTripCode: wrongTrip?.code || '',
      pickupTripCode: pickupTrip?.code || '',
      vehicleCode: vehicle?.code || '',
      driverName: driver?.name || '',
      boardStationName: board?.name || '',
      currentStationName: current?.name || '',
      alightStationName: alight?.name || '',
      destStationName: dest?.name || '',
      statusText: this.statusText(tr.status),
      typeLabel: this.typeName(tr.ticketType),
      incidentStatus: incident?.status || '',
    };
  }

  private pickupDirectionOf(tr: WrongBoardingTransfer, stations: Station[]): Dir {
    const alight = stations.find(s => s.id === tr.alightStationId)?.seq || 0;
    const dest = stations.find(s => s.id === tr.destStationId)?.seq || 0;
    return alight < dest ? 'forward' : 'backward';
  }

  /* ================= 内部工具 ================= */

  private buildSteps(args: {
    ticket: Ticket; alightName: string; destName: string;
    pickupDir: Dir; pickupTripCode: string; needWheelchair: boolean;
  }): TransferStep[] {
    const { ticket, alightName, destName, pickupDir, pickupTripCode } = args;
    const dirText = this.dirLabel(pickupDir);
    const typeSteps: Record<string, string> = {
      single: '单程票误乘区间不另收费用；在换乘站由站务登记，无需重新排队，等待时间自动计入额外等待',
      loop: '环线票当日不限乘次：在本站对向站台直接换乘即可，原票继续有效，无需补票',
      parent_child: `亲子一行 ${ticket.partySize} 人一同换乘，儿童/婴儿车就近车门优先下车，不与家人走散`,
      accessible_priority: '按无障碍优先组安排最近一班可接应车辆，全程优先通道并预留轮椅位，站务协助轮椅固定',
    };
    return [
      { seq: 1, title: '车上安抚', detail: `司机向${ticket.visitorName}说明坐反方向，请留在车上，前方到达「${alightName}」再下车，不要中途折返或回原站排队` },
      { seq: 2, title: '下一站接应', detail: `「${alightName}」工作人员车门接应，引导一行 ${ticket.partySize} 人到对向站台优先通道，全程免重新排队${args.needWheelchair ? '，并准备轮椅渡板' : ''}` },
      { seq: 3, title: '乘接驳车返回', detail: `换乘${dirText}接驳车${pickupTripCode ? ` ${pickupTripCode}` : '（调度安排中）'}前往「${destName}」，剩余路线与到站提醒同步到游客端` },
      { seq: 4, title: '票种规则', detail: typeSteps[ticket.type] || typeSteps.single },
      { seq: 5, title: '等待与退改', detail: '平台记录游客是否接受方案及是否产生额外等待；若后续发起退票，客服可看到完整行程变化作为责任判定依据' },
    ];
  }

  private nextStationAlong(stations: Station[], fromId: number, dir: Dir, isLoop: boolean): Station | null {
    const idx = stations.findIndex(s => s.id === fromId);
    if (idx < 0) return null;
    if (dir === 'forward' || dir === 'loop') {
      if (idx + 1 < stations.length) return stations[idx + 1];
      return isLoop ? stations[0] : null;
    }
    if (idx - 1 >= 0) return stations[idx - 1];
    return isLoop ? stations[stations.length - 1] : null;
  }

  private stopsBetween(stations: Station[], fromId: number, toId: number, dir: Dir, isLoop: boolean): number {
    const cur = stations.find(s => s.id === fromId);
    const dest = stations.find(s => s.id === toId);
    if (!cur || !dest) return 0;
    if (dir === 'forward') return isLoop
      ? (dest.seq - cur.seq + stations.length) % stations.length
      : Math.max(0, dest.seq - cur.seq);
    return isLoop
      ? (cur.seq - dest.seq + stations.length) % stations.length
      : Math.max(0, cur.seq - dest.seq);
  }

  private remainingText(stations: Station[], fromId: number, toId: number, dir: Dir, isLoop: boolean) {
    const cur = stations.find(s => s.id === fromId);
    const dest = stations.find(s => s.id === toId);
    if (!cur || !dest) return '';
    const n = this.stopsBetween(stations, fromId, toId, dir, isLoop);
    const walk = (() => {
      const startIdx = stations.findIndex(s => s.id === fromId);
      const out: string[] = [];
      for (let k = 0; k <= Math.min(n, stations.length - 1); k++) {
        const idx = dir === 'forward'
          ? (startIdx + k) % stations.length
          : (startIdx - k + stations.length * 2) % stations.length;
        out.push(stations[idx].name);
      }
      return out.join(' → ');
    })();
    return `${walk}（${this.dirLabel(dir)}，约 ${n} 站）`;
  }

  private matchPickupTrip(trips: Trip[], stations: Station[], alightId: number, destId: number, dir: Dir): Trip | null {
    for (const t of trips) {
      if (t.direction !== 'loop' && t.direction !== dir) continue;
      if (!this.tripCovers(t, stations, alightId)) continue;
      // 能把游客带向目的地：接驳班终点需在目的地或越过它
      const destSeq = stations.find(s => s.id === destId)?.seq ?? -1;
      const tripDestSeq = stations.find(s => s.id === t.destStationId)?.seq ?? -1;
      if (dir === 'forward' ? tripDestSeq >= destSeq : tripDestSeq <= destSeq) return t;
    }
    return null;
  }

  private tripCovers(trip: Trip, stations: Station[], stationId: number): boolean {
    const seq = stations.find(s => s.id === stationId)?.seq;
    const o = stations.find(s => s.id === trip.originStationId)?.seq;
    const d = stations.find(s => s.id === trip.destStationId)?.seq;
    if (seq === undefined || o === undefined || d === undefined) return false;
    if (trip.direction === 'backward') return seq <= o && seq >= d;
    return seq >= o && seq <= d;
  }

  private stationById(stations: Station[], id: number): Station | undefined {
    return stations.find(s => s.id === id);
  }

  private nameOf(stations: Station[], id: number): string {
    return this.stationById(stations, id)?.name || `#${id}`;
  }

  private async stationName(id: number): Promise<string> {
    return (await this.stations.findOne({ where: { id } }))?.name || `#${id}`;
  }

  private async require(id: number, statuses?: TransferStatusLike[]): Promise<WrongBoardingTransfer> {
    const tr = await this.repo.findOne({ where: { id } });
    if (!tr) throw new NotFoundException('换乘方案不存在');
    if (statuses && !statuses.includes(tr.status)) {
      throw new BadRequestException(`方案当前状态「${this.statusText(tr.status)}」，不能执行该操作`);
    }
    return tr;
  }

  private dirLabel(d: Dir) {
    return d === 'forward' ? '上行' : d === 'backward' ? '下行' : '环线';
  }

  private typeName(t: string) {
    return ({
      single: '单程票', loop: '环线票', parent_child: '亲子票', accessible_priority: '无障碍优先票',
    } as Record<string, string>)[t] || t;
  }

  private statusText(s: string) {
    return ({
      proposed: '待游客确认', accepted: '已接受·执行中', declined: '游客拒绝',
      completed: '换乘完成·待游客确认', archived: '已归档',
    } as Record<string, string>)[s] || s;
  }
}

type TransferStatusLike = WrongBoardingTransfer['status'];
