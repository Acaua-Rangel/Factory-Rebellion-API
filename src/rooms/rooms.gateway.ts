import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PublicSession, SessionService } from '../session/session.service';
import { JoinLimiter } from './join-limiter';
import { RoomError, RoomEvent } from './room.types';
import { RoomsService } from './rooms.service';

const LIMITER_PRUNE_MS = 60_000;

// Turns room messages into RoomsService calls and RoomsService events into
// messages. Client → server: room.create, room.list, room.join, room.leave,
// room.settings, room.start, room.kick. Server → client: room.state,
// room.list, room.left, room.kicked, room.started, and error {code, message}.
@Injectable()
export class RoomsGateway implements OnModuleInit, OnModuleDestroy {
  private pruner?: NodeJS.Timeout;

  constructor(
    private readonly realtime: RealtimeGateway,
    private readonly rooms: RoomsService,
    private readonly sessions: SessionService,
    private readonly limiter: JoinLimiter,
  ) {}

  onModuleInit(): void {
    this.on('room.create', (me, data) => this.rooms.createRoom(me, data));
    this.on('room.list', (me) =>
      this.realtime.sendTo(me.sessionId, 'room.list', {
        rooms: this.rooms.listPublic(),
      }),
    );
    this.on('room.join', (me, data) =>
      this.rooms.join(me, (data as { code?: unknown } | undefined)?.code),
    );
    this.on('room.leave', (me) => {
      const code = this.rooms.roomOf(me.sessionId)?.code;
      this.rooms.leave(me.sessionId);
      this.realtime.sendTo(me.sessionId, 'room.left', { code });
    });
    this.on('room.settings', (me, data) =>
      this.rooms.updateSettings(me.sessionId, data),
    );
    this.on('room.start', (me) => this.rooms.start(me.sessionId));
    this.on('room.kick', (me, data) => {
      const target = (data as { sessionId?: unknown } | undefined)?.sessionId;
      this.rooms.kick(me.sessionId, typeof target === 'string' ? target : '');
    });

    this.rooms.onEvent((event) => this.deliver(event));

    this.realtime.onSessionEvent(({ type, sessionId }) => {
      if (type === 'connected') {
        this.rooms.setConnected(sessionId, true);
        // a player coming back (or a fresh page) learns where they are
        const room = this.rooms.roomOf(sessionId);
        if (room) {
          this.realtime.sendTo(
            sessionId,
            'room.state',
            this.rooms.viewOf(room),
          );
        }
      } else if (type === 'disconnected') {
        this.rooms.setConnected(sessionId, false);
      } else {
        this.rooms.removeSession(sessionId);
      }
    });

    this.pruner = setInterval(() => this.limiter.prune(), LIMITER_PRUNE_MS);
    this.pruner.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.pruner);
  }

  private on(
    type: string,
    handler: (me: PublicSession, data: unknown) => unknown,
  ): void {
    this.realtime.registerHandler(type, ({ session }, data) => {
      const me = this.sessions.toPublic(session);
      try {
        handler(me, data);
      } catch (error) {
        if (!(error instanceof RoomError)) {
          throw error; // a real bug: the realtime gateway answers internal_error
        }
        this.realtime.sendTo(me.sessionId, 'error', {
          code: error.code,
          message: error.message,
        });
      }
    });
  }

  private deliver(event: RoomEvent): void {
    switch (event.type) {
      case 'updated':
        for (const member of event.room.members) {
          this.realtime.sendTo(member.sessionId, 'room.state', event.room);
        }
        break;
      case 'started':
        for (const member of event.room.members) {
          this.realtime.sendTo(member.sessionId, 'room.started', {
            code: event.room.code,
          });
        }
        break;
      case 'kicked':
        this.realtime.sendTo(event.sessionId, 'room.kicked', {
          code: event.code,
          message: 'you were removed from the room',
        });
        break;
      case 'deleted':
        break;
    }
  }
}
