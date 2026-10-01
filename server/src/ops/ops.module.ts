import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  QueueEntry, Ticket, Trip, Vehicle, Incident, Refund, Station,
} from '../entities';
import { OpsService } from './ops.service';
import { OpsController } from './ops.controller';
import { TransferModule } from '../transfer/transfer.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      QueueEntry, Ticket, Trip, Vehicle, Incident, Refund, Station,
    ]),
    TransferModule,
  ],
  providers: [OpsService],
  controllers: [OpsController],
})
export class OpsModule {}
