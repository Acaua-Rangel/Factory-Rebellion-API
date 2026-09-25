import { INestApplication } from '@nestjs/common';
import { SessionModule } from '../session/session.module';
import { SessionService } from '../session/session.service';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeModule } from './realtime.module';
import { connect, sleep, startApp, TestClient } from './realtime-test-utils';

describe('Realtime heartbeat and flood protection', () => {
  let app: INestApplication;
  let url: string;
  let sessions: SessionService;
  let gateway: RealtimeGateway;
  let now: number;
  const clients: TestClient[] = [];

  const login = async (nickname = 'ZE') => {
    const session = sessions.create(nickname);
    const client = await connect(url);
    clients.push(client);
    client.send({ t: 'hello', d: { token: session.token } });
    await client.next('welcome');
    return { session, client };
  };

  beforeEach(async () => {
    ({ app, url } = await startApp([SessionModule, RealtimeModule]));
    sessions = app.get(SessionService);
    gateway = app.get(RealtimeGateway);
    now = 1_000_000;
    gateway.clock = () => now;
  });

  afterEach(async () => {
    clients.splice(0).forEach((c) => c.socket.terminate());
    await app.close();
  });

  it('a ping is answered with a pong', async () => {
    const { client } = await login();

    client.send({ t: 'ping' });

    expect((await client.next('pong')).t).toBe('pong');
  });

  it('AC-012: silent clients are marked as disconnected @spec:AC-012', async () => {
    const { session, client } = await login();
    const markDisconnected = jest.spyOn(sessions, 'markDisconnected');

    now += 10_001;
    gateway.sweep();
    const closed = await client.closed;
    await sleep(50);

    expect(closed.code).toBe(4003);
    expect(closed.reason).toBe('timeout');
    expect(markDisconnected).toHaveBeenCalledWith(session.token);
  });

  it('AC-012: a client that keeps pinging stays connected @spec:AC-012', async () => {
    const { client } = await login();

    now += 6_000;
    client.send({ t: 'ping' });
    await client.next('pong');
    now += 6_000;
    gateway.sweep();
    await sleep(50);

    expect(client.socket.readyState).toBe(client.socket.OPEN);
  });

  it('AC-012: a socket that never says hello is closed after 10 seconds @spec:AC-012', async () => {
    const client = await connect(url);
    clients.push(client);
    // give the server a moment to register the connection with the fake clock
    await sleep(50);

    now += 10_001;
    gateway.sweep();

    expect((await client.closed).code).toBe(4003);
  });

  it('AC-012: sessions dropped for more than 60 seconds are purged by the sweep @spec:AC-012', async () => {
    const { session, client } = await login();
    sessions.clock = () => now;

    now += 10_001;
    gateway.sweep();
    await client.closed;
    await sleep(50);
    now += 61_000;
    gateway.sweep();

    expect(sessions.findByToken(session.token)).toBeUndefined();
  });

  it('AC-013: extra messages in one second are ignored @spec:AC-013', async () => {
    const { client } = await login();

    // hello already counted as message 1 of the current second
    for (let i = 0; i < 200; i++) {
      client.send({ t: 'ping' });
    }
    await sleep(300);
    const pongs = client.messages.filter((m) => m.t === 'pong').length;

    expect(pongs).toBe(119);
    expect(client.socket.readyState).toBe(client.socket.OPEN);
  });

  it('AC-013: a flood that continues for 5 seconds closes the connection @spec:AC-013', async () => {
    const { client } = await login();

    for (let second = 0; second < 5; second++) {
      for (let i = 0; i < 130; i++) {
        client.send({ t: 'ping' });
      }
      await sleep(100);
      now += 1_000;
    }
    const closed = await client.closed;

    expect(closed).toEqual({ code: 4004, reason: 'flood' });
  });
});
