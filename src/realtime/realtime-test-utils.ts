import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import WebSocket from 'ws';
import { AddressInfo } from 'net';

// Shared helpers for the realtime specs: a real Nest app listening on a free
// port and a tiny client that records everything the server sends.
export interface TestClient {
  socket: WebSocket;
  messages: { t: string; d?: any }[];
  closed: Promise<{ code: number; reason: string }>;
  send(value: unknown): void;
  sendRaw(text: string): void;
  next(t?: string): Promise<{ t: string; d?: any }>;
}

export async function startApp(imports: any[]): Promise<{
  app: INestApplication;
  url: string;
}> {
  const moduleRef = await Test.createTestingModule({ imports }).compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, url: `ws://127.0.0.1:${port}/ws` };
}

export function connect(url: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messages: TestClient['messages'] = [];

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
    });

    const closed = new Promise<{ code: number; reason: string }>((res) =>
      socket.on('close', (code, reason) =>
        res({ code, reason: reason.toString() }),
      ),
    );

    // messages not yet consumed by next(); waiters are woken on every message
    const wake: (() => void)[] = [];
    socket.on('message', () => wake.splice(0).forEach((w) => w()));

    const client: TestClient = {
      socket,
      messages,
      closed,
      send: (value) => socket.send(JSON.stringify(value)),
      sendRaw: (text) => socket.send(text),
      next: async (t) => {
        for (;;) {
          const index = messages.findIndex((m) => t === undefined || m.t === t);
          if (index >= 0) {
            return messages.splice(index, 1)[0];
          }
          await new Promise<void>((resolve) => wake.push(resolve));
        }
      },
    };

    socket.once('open', () => resolve(client));
    socket.once('error', reject);
  });
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
