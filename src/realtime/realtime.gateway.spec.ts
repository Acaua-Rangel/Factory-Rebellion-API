import { INestApplication } from '@nestjs/common';
import { SessionModule } from '../session/session.module';
import { SessionService } from '../session/session.service';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeModule } from './realtime.module';
import { connect, sleep, startApp, TestClient } from './realtime-test-utils';

describe('Realtime gateway handshake', () => {
  let app: INestApplication;
  let url: string;
  let sessions: SessionService;
  const clients: TestClient[] = [];

  const open = async () => {
    const client = await connect(url);
    clients.push(client);
    return client;
  };

  beforeEach(async () => {
    ({ app, url } = await startApp([SessionModule, RealtimeModule]));
    sessions = app.get(SessionService);
  });

  afterEach(async () => {
    clients.splice(0).forEach((c) => c.socket.terminate());
    await app.close();
  });

  it('AC-009: a valid session connects @spec:AC-009', async () => {
    const session = sessions.create('ZE');
    const client = await open();

    client.send({ t: 'hello', d: { token: session.token } });
    const welcome = await client.next('welcome');

    expect(welcome.d).toEqual({
      sessionId: session.sessionId,
      nickname: 'ZE',
    });
    expect(JSON.stringify(welcome)).not.toContain(session.token);
  });

  it('AC-010: an unknown token is disconnected @spec:AC-010', async () => {
    const client = await open();

    client.send({ t: 'hello', d: { token: 'not-a-real-token' } });
    const closed = await client.closed;

    expect(closed).toEqual({ code: 4001, reason: 'invalid session' });
  });

  it('AC-010: an expired session is disconnected @spec:AC-010', async () => {
    const session = sessions.create('ZE');
    sessions.markDisconnected(session.token);
    sessions.clock = () => Date.now() + 61_000;

    const client = await open();
    client.send({ t: 'hello', d: { token: session.token } });

    expect(await client.closed).toEqual({
      code: 4001,
      reason: 'invalid session',
    });
  });

  it('AC-010: a hello without a token is disconnected @spec:AC-010', async () => {
    const client = await open();

    client.send({ t: 'hello', d: {} });

    expect((await client.closed).code).toBe(4001);
  });

  it('AC-011: a broken message does not drop the player @spec:AC-011', async () => {
    const session = sessions.create('ZE');
    const client = await open();
    client.send({ t: 'hello', d: { token: session.token } });
    await client.next('welcome');

    client.sendRaw('this is not json');
    const error = await client.next('error');

    expect(error.d).toEqual({ code: 'bad_message' });
    expect(client.socket.readyState).toBe(client.socket.OPEN);
  });

  it('AC-011: an unknown message type does not drop the player @spec:AC-011', async () => {
    const session = sessions.create('ZE');
    const client = await open();
    client.send({ t: 'hello', d: { token: session.token } });
    await client.next('welcome');

    client.send({ t: 'fly-to-the-moon' });
    const error = await client.next('error');
    await sleep(50);

    expect(error.d).toEqual({ code: 'bad_message' });
    expect(client.socket.readyState).toBe(client.socket.OPEN);
  });

  it('AC-011: a message that is not an envelope is refused, connection stays open @spec:AC-011', async () => {
    const client = await open();

    client.send([1, 2, 3]);
    const error = await client.next('error');

    expect(error.d).toEqual({ code: 'bad_message' });
    expect(client.socket.readyState).toBe(client.socket.OPEN);
  });

  it('a second connection with the same session replaces the first', async () => {
    const session = sessions.create('ZE');
    const first = await open();
    first.send({ t: 'hello', d: { token: session.token } });
    await first.next('welcome');

    const second = await open();
    second.send({ t: 'hello', d: { token: session.token } });
    await second.next('welcome');

    expect(await first.closed).toEqual({ code: 4002, reason: 'replaced' });
    expect(second.socket.readyState).toBe(second.socket.OPEN);
  });

  it('messages before hello are refused with not_authenticated', async () => {
    const client = await open();

    client.send({ t: 'ping' });
    const error = await client.next('error');

    expect(error.d).toEqual({ code: 'not_authenticated' });
  });
});

describe('Realtime gateway robustness', () => {
  let app: INestApplication;
  let url: string;
  let sessions: SessionService;
  let gateway: RealtimeGateway;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    ({ app, url } = await startApp([SessionModule, RealtimeModule]));
    sessions = app.get(SessionService);
    gateway = app.get(RealtimeGateway);
  });

  afterEach(async () => {
    clients.splice(0).forEach((c) => c.socket.terminate());
    await app.close();
  });

  const login = async () => {
    const session = sessions.create('ZE');
    const client = await connect(url);
    clients.push(client);
    client.send({ t: 'hello', d: { token: session.token } });
    await client.next('welcome');
    return { session, client };
  };

  it('a handler that throws answers internal_error and the connection survives', async () => {
    gateway.registerHandler('boom', () => {
      throw new Error('bug in a handler');
    });
    const { client } = await login();

    client.send({ t: 'boom' });
    const error = await client.next('error');
    client.send({ t: 'ping' });

    expect(error.d).toEqual({ code: 'internal_error' });
    expect((await client.next('pong')).t).toBe('pong');
  });

  it('session events: connected, disconnected and expired are announced', async () => {
    const events: string[] = [];
    gateway.onSessionEvent((e) => events.push(`${e.type}:${e.sessionId}`));
    const { session, client } = await login();
    let now = Date.now();
    sessions.clock = () => now;

    client.socket.terminate();
    await sleep(100);
    now += 61_000;
    gateway.sweep();

    expect(events).toEqual([
      `connected:${session.sessionId}`,
      `disconnected:${session.sessionId}`,
      `expired:${session.sessionId}`,
    ]);
  });

  it('an expired session that says hello is announced as expired too', async () => {
    const events: string[] = [];
    gateway.onSessionEvent((e) => events.push(e.type));
    const session = sessions.create('ZE');
    let now = Date.now();
    sessions.clock = () => now;
    sessions.markDisconnected(session.token);
    now += 61_000;

    const client = await connect(url);
    clients.push(client);
    client.send({ t: 'hello', d: { token: session.token } });
    await client.closed;

    expect(events).toEqual(['expired']);
  });
});
