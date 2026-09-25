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

export type ResumeResult =
  | { status: 'resumed'; session: Session }
  | { status: 'expired' };

// How long a dropped player keeps their identity (and, later, their seat).
export const RECONNECT_GRACE_MS = 60_000;

@Injectable()
export class SessionService {
  // Injectable clock so tests don't have to wait 60 real seconds.
  clock: () => number = () => Date.now();

  private readonly sessionsByToken = new Map<string, Session>();
  private readonly disconnectedAt = new Map<string, number>();
  private readonly expiryListeners: ((sessionId: string) => void)[] = [];

  // Told (with the public session id) whenever a session ends for good, so
  // rooms can free the seat. Fires from resume() and from purgeExpired().
  onExpire(listener: (sessionId: string) => void): void {
    this.expiryListeners.push(listener);
  }

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

  // Called by the realtime gateway when a socket dies or goes silent.
  markDisconnected(token: string): void {
    if (this.sessionsByToken.has(token) && !this.disconnectedAt.has(token)) {
      this.disconnectedAt.set(token, this.clock());
    }
  }

  // Called by the realtime gateway on "hello" (also for the first connection).
  resume(token: string): ResumeResult {
    const session = this.sessionsByToken.get(token);
    if (!session) {
      return { status: 'expired' };
    }
    const droppedAt = this.disconnectedAt.get(token);
    if (
      droppedAt !== undefined &&
      this.clock() - droppedAt > RECONNECT_GRACE_MS
    ) {
      this.expire(token);
      return { status: 'expired' };
    }
    this.disconnectedAt.delete(token);
    return { status: 'resumed', session };
  }

  // Removes every session whose grace period is over; returns their public ids
  // so rooms can free the seats.
  purgeExpired(): string[] {
    const now = this.clock();
    const removed: string[] = [];
    for (const [token, droppedAt] of this.disconnectedAt) {
      if (now - droppedAt > RECONNECT_GRACE_MS) {
        const session = this.sessionsByToken.get(token);
        if (session) {
          removed.push(session.sessionId);
        }
        this.expire(token);
      }
    }
    return removed;
  }

  private expire(token: string): void {
    const session = this.sessionsByToken.get(token);
    this.remove(token);
    if (session) {
      this.expiryListeners.forEach((listener) => listener(session.sessionId));
    }
  }

  private remove(token: string): void {
    this.sessionsByToken.delete(token);
    this.disconnectedAt.delete(token);
  }
}
