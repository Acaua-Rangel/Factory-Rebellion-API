import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { SessionModule } from '../session/session.module';
import { JoinLimiter } from './join-limiter';
import { RoomsGateway } from './rooms.gateway';
import { RoomsService } from './rooms.service';

@Module({
  imports: [SessionModule, RealtimeModule],
  providers: [JoinLimiter, RoomsService, RoomsGateway],
  exports: [RoomsService],
})
export class RoomsModule {}
