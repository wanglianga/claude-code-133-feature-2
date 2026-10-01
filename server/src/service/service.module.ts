import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Refund, Ticket, Incident, Trip } from '../entities';
import { ServiceService } from './service.service';
import { ServiceController } from './service.controller';
import { IncidentsModule } from '../incidents/incidents.module';
import { TransferModule } from '../transfer/transfer.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Refund, Ticket, Incident, Trip]),
    IncidentsModule,
    TransferModule,
  ],
  providers: [ServiceService],
  controllers: [ServiceController],
})
export class ServiceModule {}
