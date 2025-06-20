import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { SecurityService } from 'src/security/security.service';

@Module({
  controllers: [AuthController],
  providers: [PrismaService, AuthService, SecurityService]
})
export class AuthModule {}
