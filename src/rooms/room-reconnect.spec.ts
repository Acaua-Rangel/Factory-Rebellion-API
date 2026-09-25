import { INestApplication } from '@nestjs/common';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { RealtimeModule } from '../realtime/realtime.module';
import {
  connect,
  sleep,
  startApp,
  TestClient,
} from '../realtime/realtime-test-utils';
import { SessionModule } from '../session/session.module';
import { PublicSession, SessionService } from '../session/session.service';
import { JoinLimiter } from './join-limiter';
import { RoomEvent } from './room.types';
import { RoomsModule } from './rooms.module';
import { RoomsService } from './rooms.service';

const player = (id: string): PublicSession => ({
  sessionId: id,
  nickname: id.toUpperCase(),
});

describe('Keeping the seat after a connection drop', () => {
  let rooms: RoomsService;
  let events: RoomEvent[];
  let code: string;

  beforeEach(() => {
    rooms = new RoomsService(new JoinLimiter());
    code = rooms.createRoom(player('ana'), {
      size: 4,
      visibility: 'public',
    }).code;
    rooms.join(player('bia'), code);
    rooms.join(player('cris'), code);
    events = [];
    rooms.onEvent((event) => events.push(event));
  });

  const seats = () =>
    rooms.getRoom(code)?.members.map((m) => `${m.sessionId}:${m.connected}`);

  it('AC-032: a dropped player keeps their seat, marked as disconnected @spec:AC-032', () => {
    rooms.setConnected('bia', false);

    expect(seats()).toEqual(['ana:true', 'bia:false', 'cris:true']);
    expect(rooms.roomOf('bia')?.code).toBe(code);
    expect(events).toEqual([
      { type: 'updated', room: expect.objectContaining({ code }) },
    ]);
  });

  it('AC-032: coming back restores the same seat @spec:AC-032', () => {
    rooms.setConnected('bia', false);
    rooms.setConnected('bia', true);

    expect(seats()).toEqual(['ana:true', 'bia:true', 'cris:true']);
  });

  it('AC-032: a dropped player still counts as a member, so the room stays full @spec:AC-032', () => {
    rooms.join(player('dani'), code);
    rooms.setConnected('dani', false);

    expect(() => rooms.join(player('late'), code)).toThrow('room full');
  });

  it('AC-032: after the grace period the seat is freed @spec:AC-032', () => {
    rooms.setConnected('bia', false);

    rooms.removeSession('bia');

    expect(seats()).toEqual(['ana:true', 'cris:true']);
    expect(rooms.roomOf('bia')).toBeUndefined();
  });

  it('AC-030: the host role passes on when the host is gone for good @spec:AC-030', () => {
    rooms.setConnected('ana', false);
    expect(rooms.getRoom(code)?.hostId).toBe('ana'); // still the host while the seat is kept

    rooms.removeSession('ana');

    expect(rooms.getRoom(code)?.hostId).toBe('bia');
  });

  it('AC-031: the room disappears when its last members expire @spec:AC-031', () => {
    for (const id of ['ana', 'bia', 'cris']) {
      rooms.setConnected(id, false);
    }
    for (const id of ['ana', 'bia', 'cris']) {
      rooms.removeSession(id);
    }

    expect(rooms.count()).toBe(0);
    expect(events.at(-1)).toEqual({ type: 'deleted', code });
  });

  it('players outside any room are ignored, no events, no errors', () => {
    events.length = 0;

    rooms.setConnected('nobody', false);
    rooms.removeSession('nobody');

    expect(events).toEqual([]);
  });

  it('nothing is emitted when the connection state does not change', () => {
    events.length = 0;

    rooms.setConnected('bia', true);

    expect(events).toEqual([]);
  });
});

describe('Keeping the seat after a connection drop, over real sockets', () => {
  let app: INestApplication;
  let url: string;
  let sessions: SessionService;
  let gateway: RealtimeGateway;
  let now: number;
  const clients: TestClient[] = [];

  const login = async (nickname: string) => {
    const session = sessions.create(nickname);
    const client = await connect(url);
    clients.push(client);
    client.send({ t: 'hello', d: { token: session.token } });
    await client.next('welcome');
    return { session, client };
  };

  const reconnect = async (token: string) => {
    const client = await connect(url);
    clients.push(client);
    client.send({ t: 'hello', d: { token } });
    return client;
  };

  const state = async (client: TestClient, ok: (s: any) => boolean) => {
    for (;;) {
      const message = await client.next('room.state');
      if (ok(message.d)) return message.d;
    }
  };

  // a live client keeps pinging; with the fake clock we must do it by hand
  const stayAlive = async (client: TestClient) => {
    client.send({ t: 'ping' });
    await client.next('pong');
  };

  const seatOf = (room: any, sessionId: string) =>
    room.members.find((m: any) => m.sessionId === sessionId);

  beforeEach(async () => {
    ({ app, url } = await startApp([
      SessionModule,
      RealtimeModule,
      RoomsModule,
    ]));
    sessions = app.get(SessionService);
    gateway = app.get(RealtimeGateway);
    now = 1_000_000;
    sessions.clock = () => now;
    gateway.clock = () => now;
  });

  afterEach(async () => {
    clients.splice(0).forEach((c) => c.socket.terminate());
    await app.close();
  });

  it('AC-032: a dropped player is shown as disconnected, then comes back to the same seat @spec:AC-032', async () => {
    const ana = await login('ANA');
    ana.client.send({ t: 'room.create', d: { size: 4, visibility: 'public' } });
    const room = await state(ana.client, () => true);
    const bia = await login('BIA');
    bia.client.send({ t: 'room.join', d: { code: room.code } });
    await state(ana.client, (s) => s.members.length === 2);

    bia.client.socket.terminate();
    const dropped = await state(
      ana.client,
      (s) => seatOf(s, bia.session.sessionId)?.connected === false,
    );
    now += 30_000;
    const back = await reconnect(bia.session.token);
    const seenByBia = await state(back, (s) => s.code === room.code);
    const seenByAna = await state(
      ana.client,
      (s) => seatOf(s, bia.session.sessionId)?.connected === true,
    );

    expect(dropped.members.map((m: any) => m.nickname)).toEqual(['ANA', 'BIA']);
    expect(seenByBia.members.map((m: any) => m.nickname)).toEqual([
      'ANA',
      'BIA',
    ]);
    expect(seenByAna.members.map((m: any) => m.nickname)).toEqual([
      'ANA',
      'BIA',
    ]);
  });

  it('AC-032: after 60 seconds without coming back the seat is freed @spec:AC-032', async () => {
    const ana = await login('ANA');
    ana.client.send({ t: 'room.create', d: { size: 4, visibility: 'public' } });
    const room = await state(ana.client, () => true);
    const bia = await login('BIA');
    bia.client.send({ t: 'room.join', d: { code: room.code } });
    await state(ana.client, (s) => s.members.length === 2);

    bia.client.socket.terminate();
    await state(
      ana.client,
      (s) => seatOf(s, bia.session.sessionId)?.connected === false,
    );
    now += 61_000;
    await stayAlive(ana.client);
    gateway.sweep();
    const after = await state(ana.client, (s) => s.members.length === 1);

    expect(after.members.map((m: any) => m.nickname)).toEqual(['ANA']);
    // and the old session can no longer come back
    const late = await reconnect(bia.session.token);
    expect((await late.closed).reason).toBe('invalid session');
  });

  it('AC-030: the host role passes on when the host expires @spec:AC-030', async () => {
    const ana = await login('ANA');
    ana.client.send({ t: 'room.create', d: { size: 4, visibility: 'public' } });
    const room = await state(ana.client, () => true);
    const bia = await login('BIA');
    bia.client.send({ t: 'room.join', d: { code: room.code } });
    await state(bia.client, (s) => s.members.length === 2);

    ana.client.socket.terminate();
    await state(
      bia.client,
      (s) => seatOf(s, ana.session.sessionId)?.connected === false,
    );
    now += 61_000;
    await stayAlive(bia.client);
    gateway.sweep();
    const after = await state(bia.client, (s) => s.members.length === 1);

    expect(after.hostId).toBe(bia.session.sessionId);
  });

  it('AC-032: a player that reconnects while the server did not notice the drop still learns their room @spec:AC-032', async () => {
    const ana = await login('ANA');
    ana.client.send({ t: 'room.create', d: { size: 4, visibility: 'public' } });
    const room = await state(ana.client, () => true);

    // second connection with the same session replaces the first
    const again = await reconnect(ana.session.token);
    const seen = await state(again, (s) => s.code === room.code);
    await sleep(20);

    expect(seatOf(seen, ana.session.sessionId).connected).toBe(true);
  });
});
