import { Body, Controller, Post } from '@nestjs/common';
import { CreateSessionDTO } from './dtos/create-session.dto';
import { Session, SessionService } from './session.service';

@Controller('sessions')
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  // The token is returned here, only to its owner, and never again (P-005).
  @Post()
  create(@Body() body: CreateSessionDTO): Session {
    return this.sessions.create(body.nickname);
  }
}
