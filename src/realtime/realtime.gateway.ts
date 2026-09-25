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

export interface Connection {
  socket: WebSocket;
  // set once "hello" succeeds
  session?: Session;
}

export type MessageHandler = (
  connection: Connection & { session: Session },
  data: unknown,
) => void;

@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private wss?: WebSocketServer;
  private readonly connections = new Set<Connection>();
  // sessionId -> the one live connection of that session
  private readonly bySession = new Map<string, Connection>();
  private readonly handlers = new Map<string, MessageHandler>();

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly sessions: SessionService,
  ) {}

  onApplicationBootstrap(): void {
    const server = this.httpAdapterHost.httpAdapter.getHttpServer();
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (socket) => this.onConnection(socket));
  }

  onModuleDestroy(): void {
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

  private onConnection(socket: WebSocket): void {
    const connection: Connection = { socket };
    this.connections.add(connection);

    socket.on('message', (raw) => this.onMessage(connection, raw));
    socket.on('close', () => this.onClose(connection));
    socket.on('error', (error) => this.logger.warn(error.message));
  }

  private onMessage(connection: Connection, raw: RawData): void {
    const envelope = parseEnvelope(raw.toString());
    if (!envelope) {
      return this.sendError(connection, ERROR.BAD_MESSAGE);
    }

    if (envelope.t === 'hello') {
      return this.onHello(connection, envelope);
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
      connection.socket.close(CLOSE.INVALID_SESSION, 'invalid session');
      return;
    }

    const { session } = result;
    const previous = this.bySession.get(session.sessionId);
    if (previous && previous !== connection) {
      // drop it from the map first so its close event doesn't mark the
      // session as disconnected
      this.bySession.delete(session.sessionId);
      previous.socket.close(CLOSE.REPLACED, 'replaced');
    }

    connection.session = session;
    this.bySession.set(session.sessionId, connection);
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

  private sendError(connection: Connection, code: string): void {
    this.send(connection.socket, 'error', { code });
  }

  private send(socket: WebSocket, t: string, d?: unknown): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ t, d }));
    }
  }
}
