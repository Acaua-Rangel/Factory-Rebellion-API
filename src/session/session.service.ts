import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';

export interface Session {
  sessionId: string;
  token: string;
  nickname: string;
}

// What other players may see: never includes the token (P-005).
export interface PublicSession {
  sessionId: string;
  nickname: string;
}

@Injectable()
export class SessionService {
  private readonly sessionsByToken = new Map<string, Session>();

  create(nickname: string): Session {
    const session: Session = {
      sessionId: randomUUID(),
      token: randomBytes(16).toString('hex'), // 128 bits from a CSPRNG (ASM-003)
      nickname,
    };
    this.sessionsByToken.set(session.token, session);
    return session;
  }

  findByToken(token: string): Session | undefined {
    return this.sessionsByToken.get(token);
  }

  toPublic(session: Session): PublicSession {
    return { sessionId: session.sessionId, nickname: session.nickname };
  }

  count(): number {
    return this.sessionsByToken.size;
  }
}
