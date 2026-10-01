import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  QueueEntry, Ticket, Trip, Vehicle, Incident, Refund, Station, WrongBoardingTransfer,
} from '../entities';
import { OpsService } from './ops.service';
import { OpsController } from './ops.controller';

@Module({
  imports: [TypeOrmModule.forFeature([
    QueueEntry, Ticket, Trip, Vehicle, Incident, Refund, Station, WrongBoardingTransfer,
  ])],
  providers: [OpsService],
  controllers: [OpsController],
})
export class OpsModule {}
