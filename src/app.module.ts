import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RealtimeModule } from './realtime/realtime.module';
import { MatchModule } from './match/match.module';
import { RoomsModule } from './rooms/rooms.module';
import { SessionModule } from './session/session.module';

@Module({
  imports: [SessionModule, RealtimeModule, RoomsModule, MatchModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
