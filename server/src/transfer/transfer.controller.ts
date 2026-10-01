import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { TransferService } from './transfer.service';

@Controller('transfer-plans')
export class TransferController {
  constructor(private readonly svc: TransferService) {}

  @Get()
  list(@Query('status') status?: string,
       @Query('ticketId') ticketId?: string,
       @Query('tripId') tripId?: string,
       @Query('stationId') stationId?: string) {
    return this.svc.list({
      status,
      ticketId: ticketId ? Number(ticketId) : undefined,
      tripId: tripId ? Number(tripId) : undefined,
      stationId: stationId ? Number(stationId) : undefined,
    });
  }

  @Get('stats')
  stats() {
    return this.svc.stats();
  }

  @Get('ticket/:ticketId')
  byTicket(@Param('ticketId') ticketId: string) {
    return this.svc.forTicket(Number(ticketId));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.svc.get(Number(id));
  }

  /** 司机/工作人员在车上发现误乘（非检票口强制放行场景）→ 生成方案 */
  @Post()
  create(@Body() body: {
    ticketId: number; wrongTripId: number; boardStationId?: number;
    raisedByRole?: 'staff' | 'driver' | 'dispatch';
  }) {
    return this.svc.createForWrongBoarding(body);
  }

  /** 调度/站务确认换乘选项（下一站与游客端同步） */
  @Post(':id/confirm')
  confirm(@Param('id') id: string, @Body() body: {
    optionId: string;
    connectTripId?: number | null;
    transferStationId?: number | null;
    note?: string;
    byRole?: 'dispatch' | 'staff';
  }) {
    return this.svc.confirm(Number(id), body);
  }

  /** 司机知悉提醒 */
  @Post(':id/driver-ack')
  driverAck(@Param('id') id: string) {
    return this.svc.driverAck(Number(id));
  }

  /** 下一站接应登记（游客免重新排队，进入优先交接队列） */
  @Post(':id/staff-meet')
  staffMeet(@Param('id') id: string,
            @Body() body: { note?: string; actualWaitMinutes?: number }) {
    return this.svc.staffMeet(Number(id), body);
  }

  /** 下一站工作人员补充备注（方案确认后持续同步） */
  @Post(':id/staff-note')
  staffNote(@Param('id') id: string, @Body() body: { note: string }) {
    return this.svc.staffNote(Number(id), body.note);
  }

  /** 游客接受 / 拒绝换乘方案 */
  @Post(':id/visitor-decide')
  visitorDecide(@Param('id') id: string,
                @Body() body: { accept: boolean; reason?: string }) {
    return this.svc.visitorDecide(Number(id), body);
  }

  /** 游客拒绝 → 工作人员代为发起退票（客服可见完整行程变化） */
  @Post(':id/request-refund')
  requestRefund(@Param('id') id: string,
                @Body() body: { reason?: string; faultTag?: any }) {
    return this.svc.requestRefund(Number(id), body);
  }

  /** 游客确认后归档 */
  @Post(':id/archive')
  archive(@Param('id') id: string,
          @Body() body: { byRole?: 'visitor' | 'staff' | 'service' }) {
    return this.svc.archive(Number(id), body || {});
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body() body: { reason: string }) {
    return this.svc.cancel(Number(id), body.reason || '调度作废');
  }
}
