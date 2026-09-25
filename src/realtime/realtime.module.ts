import { Module } from '@nestjs/common';
import { SessionModule } from '../session/session.module';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [SessionModule],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
