import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { TransfersService } from './transfers.service';

@Controller('transfers')
export class TransfersController {
  constructor(private readonly svc: TransfersService) {}

  /** 生成误上反方向换乘方案（票种 / 当前位置 / 剩余路线） */
  @Post('plans')
  create(@Body() body: {
    ticketId: number;
    wrongTripId: number;
    boardStationId?: number;
    currentStationId?: number;
    raisedByRole?: 'staff' | 'driver' | 'dispatch' | 'system';
  }) {
    return this.svc.createPlan({
      ticketId: Number(body.ticketId),
      wrongTripId: Number(body.wrongTripId),
      boardStationId: body.boardStationId ? Number(body.boardStationId) : undefined,
      currentStationId: body.currentStationId ? Number(body.currentStationId) : undefined,
      raisedByRole: body.raisedByRole || 'staff',
    });
  }

  @Get('plans')
  list(@Query('status') status?: string,
       @Query('ticketId') ticketId?: string,
       @Query('driverId') driverId?: string,
       @Query('stationId') stationId?: string) {
    return this.svc.list({
      status,
      ticketId: ticketId ? Number(ticketId) : undefined,
      driverId: driverId ? Number(driverId) : undefined,
      stationId: stationId ? Number(stationId) : undefined,
    });
  }

  @Get('by-ticket/:ticketId')
  byTicket(@Param('ticketId') ticketId: string) {
    return this.svc.byTicket(Number(ticketId));
  }

  @Get('plans/:id')
  detail(@Param('id') id: string) {
    return this.svc.detail(Number(id));
  }

  /** 游客接受方案（行程变化同步游客端） */
  @Post('plans/:id/accept')
  accept(@Param('id') id: string, @Body() body: { note?: string }) {
    return this.svc.accept(Number(id), body.note || '');
  }

  /** 游客不接受 */
  @Post('plans/:id/decline')
  decline(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.svc.decline(Number(id), body.reason || '');
  }

  /** 司机确认收到提醒 */
  @Post('plans/:id/driver-ack')
  driverAck(@Param('id') id: string) {
    return this.svc.driverAck(Number(id));
  }

  /** 下一站工作人员确认收到提醒 */
  @Post('plans/:id/station-ack')
  stationAck(@Param('id') id: string, @Body() body: { note?: string }) {
    return this.svc.stationAck(Number(id), body.note || '');
  }

  /** 调度锁定/改派接驳班次 */
  @Post('plans/:id/assign-pickup')
  assign(@Param('id') id: string,
         @Body() body: { tripId: number; note?: string }) {
    return this.svc.assignPickup(Number(id), Number(body.tripId), body.note || '');
  }

  /** 下一站确认游客已换乘，登记实际额外等待 */
  @Post('plans/:id/complete')
  complete(@Param('id') id: string,
           @Body() body: { actualExtraWaitMinutes?: number; note?: string }) {
    return this.svc.complete(Number(id), body);
  }

  /** 游客确认后归档 */
  @Post('plans/:id/archive')
  archive(@Param('id') id: string, @Body() body: { note?: string }) {
    return this.svc.archive(Number(id), body.note || '');
  }
}
