import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ticket, Refund, QueueEntry, Station } from '../entities';
import { TicketsService } from './tickets.service';
import { TicketsController } from './tickets.controller';
import { IncidentsModule } from '../incidents/incidents.module';
import { TransfersModule } from '../transfers/transfers.module';

@Module({
  imports: [TypeOrmModule.forFeature([Ticket, Refund, QueueEntry, Station]), IncidentsModule, TransfersModule],
  providers: [TicketsService],
  controllers: [TicketsController],
  exports: [TicketsService],
})
export class TicketsModule {}
