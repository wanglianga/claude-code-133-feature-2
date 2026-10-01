import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  WrongBoardingTransfer, Ticket, Trip, Vehicle, Driver, Station, RouteLine, Incident,
} from '../entities';
import { TransfersService } from './transfers.service';
import { TransfersController } from './transfers.controller';
import { IncidentsModule } from '../incidents/incidents.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WrongBoardingTransfer, Ticket, Trip, Vehicle, Driver, Station, RouteLine, Incident,
    ]),
    IncidentsModule,
  ],
  providers: [TransfersService],
  controllers: [TransfersController],
  exports: [TransfersService],
})
export class TransfersModule {}
