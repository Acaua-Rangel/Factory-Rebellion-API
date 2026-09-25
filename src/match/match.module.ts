import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { RoomsModule } from '../rooms/rooms.module';
import { SessionModule } from '../session/session.module';
import { MatchGateway } from './match.gateway';
import { MatchService } from './match.service';

@Module({
  imports: [SessionModule, RealtimeModule, RoomsModule],
  providers: [MatchService, MatchGateway],
  exports: [MatchService],
})
export class MatchModule {}
