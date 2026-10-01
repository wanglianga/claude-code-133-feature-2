import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Vehicle, Driver, Trip, Ticket, QueueEntry, Station, RouteLine, Weather,
  RoadControl, GeofenceEvent, SafetyCheck, CharterOrder, Incident, Refund,
} from '../entities';
import { DispatchService } from './dispatch.service';
import { DispatchController } from './dispatch.controller';
import { IncidentsModule } from '../incidents/incidents.module';
import { TransferModule } from '../transfer/transfer.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Vehicle, Driver, Trip, Ticket, QueueEntry, Station, RouteLine, Weather,
      RoadControl, GeofenceEvent, SafetyCheck, CharterOrder, Incident, Refund,
    ]),
    IncidentsModule,
    TransferModule,
  ],
  providers: [DispatchService],
  controllers: [DispatchController],
  exports: [DispatchService],
})
export class DispatchModule {}
