import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { Session, SessionService } from '../session/session.service';
import { CLOSE, ERROR, Envelope, parseEnvelope } from './protocol';
import { RateLimiter } from './rate-limit';

// A client that sends nothing (not even a ping) for this long is considered gone.
export const IDLE_TIMEOUT_MS = 10_000;
const SWEEP_INTERVAL_MS = 1_000;

export interface Connection {
  socket: WebSocket;
  // set once "hello" succeeds
  session?: Session;
  lastSeen: number;
  limiter: RateLimiter;
}

export type MessageHandler = (
  connection: Connection & { session: Session },
  data: unknown,
) => void;

@Injectable()
export class RealtimeGateway
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private wss?: WebSocketServer;
  private readonly connections = new Set<Connection>();
  // sessionId -> the one live connection of that session
  private readonly bySession = new Map<string, Connection>();
  private readonly handlers = new Map<string, MessageHandler>();
  private sweeper?: NodeJS.Timeout;

  // Injectable clock so tests don't have to wait real seconds.
  clock: () => number = () => Date.now();

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly sessions: SessionService,
  ) {}

  onApplicationBootstrap(): void {
    const server = this.httpAdapterHost.httpAdapter.getHttpServer();
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (socket) => this.onConnection(socket));
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
    this.wss?.close();
    for (const connection of this.connections) {
      connection.socket.terminate();
    }
  }

  // Feature modules (rooms, match…) plug their message types in here.
  registerHandler(type: string, handler: MessageHandler): void {
    this.handlers.set(type, handler);
  }

  sendTo(sessionId: string, t: string, d?: unknown): void {
    const connection = this.bySession.get(sessionId);
    if (connection) {
      this.send(connection.socket, t, d);
    }
  }

  // Closes connections that went silent and forgets sessions whose 60 s
  // reconnect window is over. Runs every second; public so tests can drive it.
  sweep(): void {
    const now = this.clock();
    for (const connection of this.connections) {
      if (now - connection.lastSeen > IDLE_TIMEOUT_MS) {
        this.closeSocket(connection.socket, CLOSE.TIMEOUT, 'timeout');
      }
    }
    this.sessions.purgeExpired();
  }

  private onConnection(socket: WebSocket): void {
    const connection: Connection = {
      socket,
      lastSeen: this.clock(),
      limiter: new RateLimiter(),
    };
    this.connections.add(connection);

    socket.on('message', (raw) => this.onMessage(connection, raw));
    socket.on('close', () => this.onClose(connection));
    socket.on('error', (error) => this.logger.warn(error.message));
  }

  private onMessage(connection: Connection, raw: RawData): void {
    const now = this.clock();
    connection.lastSeen = now;

    const verdict = connection.limiter.check(now);
    if (verdict === 'drop') {
      return;
    }
    if (verdict === 'close') {
      this.closeSocket(connection.socket, CLOSE.FLOOD, 'flood');
      return;
    }

    const envelope = parseEnvelope(raw.toString());
    if (!envelope) {
      return this.sendError(connection, ERROR.BAD_MESSAGE);
    }

    if (envelope.t === 'hello') {
      return this.onHello(connection, envelope);
    }
    if (envelope.t === 'ping') {
      if (!connection.session) {
        return this.sendError(connection, ERROR.NOT_AUTHENTICATED);
      }
      return this.send(connection.socket, 'pong');
    }

    const { session } = connection;
    if (!session) {
      return this.sendError(connection, ERROR.NOT_AUTHENTICATED);
    }

    const handler = this.handlers.get(envelope.t);
    if (!handler) {
      return this.sendError(connection, ERROR.BAD_MESSAGE);
    }
    handler({ ...connection, session }, envelope.d);
  }

  private onHello(connection: Connection, envelope: Envelope): void {
    const token = (envelope.d as { token?: unknown } | undefined)?.token;
    const result =
      typeof token === 'string'
        ? this.sessions.resume(token)
        : ({ status: 'expired' } as const);

    if (result.status !== 'resumed') {
      this.closeSocket(
        connection.socket,
        CLOSE.INVALID_SESSION,
        'invalid session',
      );
      return;
    }

    const { session } = result;
    const previous = this.bySession.get(session.sessionId);
    if (previous && previous !== connection) {
      // drop it from the map first so its close event doesn't mark the
      // session as disconnected
      this.bySession.delete(session.sessionId);
      this.closeSocket(previous.socket, CLOSE.REPLACED, 'replaced');
    }

    connection.session = session;
    this.bySession.set(session.sessionId, connection);
    this.logger.log(`${session.nickname} connected (${session.sessionId})`);
    this.send(connection.socket, 'welcome', this.sessions.toPublic(session));
  }

  private onClose(connection: Connection): void {
    this.connections.delete(connection);
    const { session } = connection;
    if (session && this.bySession.get(session.sessionId) === connection) {
      this.bySession.delete(session.sessionId);
      this.sessions.markDisconnected(session.token);
    }
  }

  // Politely closes, then makes sure a dead peer can't keep the socket open.
  private closeSocket(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
    setTimeout(() => socket.terminate(), 1_000).unref();
  }

  private sendError(connection: Connection, code: string): void {
    this.send(connection.socket, 'error', { code });
  }

  private send(socket: WebSocket, t: string, d?: unknown): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ t, d }));
    }
  }
}
