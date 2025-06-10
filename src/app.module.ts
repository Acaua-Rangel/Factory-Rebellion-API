import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { SecurityService } from './security/security.service';

@Module({
  imports: [AuthModule],
  controllers: [AppController],
  providers: [AppService, SecurityService],
})
export class AppModule {}
