import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  TransferPlan, Ticket, Trip, Station, RouteLine, Vehicle, Driver,
  Incident, QueueEntry, Refund,
} from '../entities';
import { TransferService } from './transfer.service';
import { TransferController } from './transfer.controller';
import { IncidentsModule } from '../incidents/incidents.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TransferPlan, Ticket, Trip, Station, RouteLine, Vehicle, Driver,
      Incident, QueueEntry, Refund,
    ]),
    IncidentsModule,
  ],
  providers: [TransferService],
  controllers: [TransferController],
  exports: [TransferService],
})
export class TransferModule {}
