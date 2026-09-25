import { INestApplication } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import {
  connect,
  sleep,
  startApp,
  TestClient,
} from '../realtime/realtime-test-utils';
import { SessionModule } from '../session/session.module';
import { Session, SessionService } from '../session/session.service';
import { RoomsModule } from './rooms.module';

describe('Rooms over the WebSocket', () => {
  let app: INestApplication;
  let url: string;
  let sessions: SessionService;
  const clients: TestClient[] = [];
  const tokens: string[] = [];

  const login = async (nickname: string) => {
    const session = sessions.create(nickname);
    tokens.push(session.token);
    const client = await connect(url);
    clients.push(client);
    client.send({ t: 'hello', d: { token: session.token } });
    await client.next('welcome');
    return { session, client };
  };

  // next room.state that satisfies the predicate (older ones are dropped)
  const state = async (
    client: TestClient,
    ok: (s: any) => boolean = () => true,
  ) => {
    for (;;) {
      const message = await client.next('room.state');
      if (ok(message.d)) return message.d;
    }
  };

  const createRoom = async (
    host: TestClient,
    settings: object = { size: 4, visibility: 'public' },
  ) => {
    host.send({ t: 'room.create', d: settings });
    return state(host);
  };

  const joinAll = async (code: string, names: string[]) => {
    const joined: { session: Session; client: TestClient }[] = [];
    for (const name of names) {
      const p = await login(name);
      p.client.send({ t: 'room.join', d: { code } });
      await state(p.client);
      joined.push(p);
    }
    return joined;
  };

  beforeEach(async () => {
    ({ app, url } = await startApp([
      SessionModule,
      RealtimeModule,
      RoomsModule,
    ]));
    sessions = app.get(SessionService);
  });

  afterEach(async () => {
    clients.splice(0).forEach((c) => c.socket.terminate());
    tokens.length = 0;
    await app.close();
  });

  it('AC-014: create room answers with the room state, creator is the host @spec:AC-014', async () => {
    const { session, client } = await login('ANA');

    client.send({
      t: 'room.create',
      d: { size: 8, visibility: 'private', rounds: 5 },
    });
    const room = await state(client);

    expect(room.code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(room.settings).toEqual({
      size: 8,
      visibility: 'private',
      rounds: 5,
    });
    expect(room.hostId).toBe(session.sessionId);
    expect(room.members).toEqual([
      { sessionId: session.sessionId, nickname: 'ANA', connected: true },
    ]);
    expect(room.phase).toBe('lobby');
  });

  it('AC-015: invalid settings answer an error and create nothing @spec:AC-015', async () => {
    const { client } = await login('ANA');

    client.send({ t: 'room.create', d: { size: 5, visibility: 'public' } });
    const error = await client.next('error');
    client.send({ t: 'room.list' });
    const list = await client.next('room.list');

    expect(error.d).toEqual({
      code: 'invalid_settings',
      message: 'invalid settings',
    });
    expect(list.d.rooms).toEqual([]);
  });

  it('AC-016: rounds default to 4 @spec:AC-016', async () => {
    const { client } = await login('ANA');

    const room = await createRoom(client, { size: 4, visibility: 'public' });

    expect(room.settings.rounds).toBe(4);
  });

  it('AC-017: settings changes reach every member @spec:AC-017', async () => {
    const { client: host } = await login('ANA');
    const room = await createRoom(host);
    const [bia] = await joinAll(room.code, ['BIA']);

    host.send({
      t: 'room.settings',
      d: { visibility: 'private', rounds: 6, size: 8 },
    });
    const seenByHost = await state(host, (s) => s.settings.rounds === 6);
    const seenByBia = await state(bia.client, (s) => s.settings.rounds === 6);

    expect(seenByHost.settings).toEqual({
      size: 8,
      visibility: 'private',
      rounds: 6,
    });
    expect(seenByBia.settings).toEqual(seenByHost.settings);
  });

  it('AC-017: a non-host changing settings is told no @spec:AC-017', async () => {
    const { client: host } = await login('ANA');
    const room = await createRoom(host);
    const [bia] = await joinAll(room.code, ['BIA']);

    bia.client.send({ t: 'room.settings', d: { rounds: 6 } });
    const error = await bia.client.next('error');

    expect(error.d.code).toBe('only_host_can_change_settings');
  });

  it('AC-019: the room list shows joinable public rooms only @spec:AC-019', async () => {
    const { client: ana } = await login('ANA');
    const publicRoom = await createRoom(ana, {
      size: 8,
      visibility: 'public',
      rounds: 5,
    });
    const { client: bia } = await login('BIA');
    await createRoom(bia, { size: 4, visibility: 'private' });
    const { client: cris } = await login('CRIS');

    cris.send({ t: 'room.list' });
    const list = await cris.next('room.list');

    expect(list.d.rooms).toEqual([
      {
        code: publicRoom.code,
        host: 'ANA',
        players: 1,
        size: 8,
        rounds: 5,
        inMatch: false,
      },
    ]);
  });

  it('AC-021: joining tells every member @spec:AC-021', async () => {
    const { client: ana } = await login('ANA');
    const room = await createRoom(ana);
    const { client: bia } = await login('BIA');

    bia.send({ t: 'room.join', d: { code: room.code } });
    const seenByBia = await state(bia);
    const seenByAna = await state(ana, (s) => s.members.length === 2);

    expect(seenByAna.members.map((m: any) => m.nickname)).toEqual([
      'ANA',
      'BIA',
    ]);
    expect(seenByBia.members.map((m: any) => m.nickname)).toEqual([
      'ANA',
      'BIA',
    ]);
    expect(seenByBia.code).toBe(room.code);
  });

  it('AC-022: a code typed in lowercase without hyphen works @spec:AC-022', async () => {
    const { client: ana } = await login('ANA');
    const room = await createRoom(ana);
    const { client: bia } = await login('BIA');

    bia.send({
      t: 'room.join',
      d: { code: room.code.replace('-', '').toLowerCase() },
    });

    expect((await state(bia)).code).toBe(room.code);
  });

  it.each([
    ['ZZZZ-ZZZZ', 'room_not_found', 'room not found'],
    ['???', 'room_not_found', 'room not found'],
  ])(
    'AC-023: joining "%s" answers %s @spec:AC-023',
    async (code, errorCode, message) => {
      const { client } = await login('ANA');

      client.send({ t: 'room.join', d: { code } });
      const error = await client.next('error');

      expect(error.d).toEqual({ code: errorCode, message });
    },
  );

  it('AC-023: a join without a code is refused, the connection stays @spec:AC-023', async () => {
    const { client } = await login('ANA');

    client.send({ t: 'room.join' });
    const error = await client.next('error');
    client.send({ t: 'ping' });

    expect(error.d.code).toBe('room_not_found');
    expect((await client.next('pong')).t).toBe('pong');
  });

  it('AC-024: a full room answers "room full" @spec:AC-024', async () => {
    const { client: ana } = await login('ANA');
    const room = await createRoom(ana, { size: 4, visibility: 'public' });
    await joinAll(room.code, ['B', 'C', 'D']);
    const { client: late } = await login('LATE');

    late.send({ t: 'room.join', d: { code: room.code } });
    const error = await late.next('error');

    expect(error.d).toEqual({ code: 'room_full', message: 'room full' });
  });

  it('AC-025: a running match answers "match in progress" @spec:AC-025', async () => {
    const { client: ana } = await login('ANA');
    const room = await createRoom(ana, { size: 4, visibility: 'public' });
    await joinAll(room.code, ['B', 'C', 'D']);
    ana.send({ t: 'room.start' });
    await ana.next('room.started');
    const { client: late } = await login('LATE');

    late.send({ t: 'room.join', d: { code: room.code } });
    const error = await late.next('error');

    expect(error.d).toEqual({
      code: 'match_in_progress',
      message: 'match in progress',
    });
  });

  it('AC-026: guessing codes over the socket gets blocked @spec:AC-026', async () => {
    const { client: ana } = await login('ANA');
    const room = await createRoom(ana);
    const { client: bia } = await login('BIA');

    for (let i = 0; i < 10; i++) {
      bia.send({ t: 'room.join', d: { code: 'ZZZZ-ZZZZ' } });
      expect((await bia.next('error')).d.code).toBe('room_not_found');
    }
    bia.send({ t: 'room.join', d: { code: room.code } });
    const blocked = await bia.next('error');

    expect(blocked.d).toEqual({
      code: 'too_many_attempts',
      message: 'too many attempts, wait a minute',
    });
  });

  it('AC-027: start needs a full room and then begins the match for everyone @spec:AC-027', async () => {
    const { client: ana } = await login('ANA');
    const room = await createRoom(ana, { size: 4, visibility: 'public' });
    const others = await joinAll(room.code, ['B', 'C']);

    ana.send({ t: 'room.start' });
    const notFull = await ana.next('error');
    const last = await joinAll(room.code, ['D']);
    ana.send({ t: 'room.start' });

    expect(notFull.d).toEqual({
      code: 'room_not_full',
      message: 'room not full',
    });
    for (const c of [
      ana,
      ...others.map((o) => o.client),
      ...last.map((o) => o.client),
    ]) {
      expect((await c.next('room.started')).d).toEqual({ code: room.code });
      expect((await state(c, (s) => s.phase === 'match')).code).toBe(room.code);
    }
  });

  it('AC-028: only the host can start @spec:AC-028', async () => {
    const { client: ana } = await login('ANA');
    const room = await createRoom(ana, { size: 4, visibility: 'public' });
    const [bia] = await joinAll(room.code, ['B', 'C', 'D']);

    bia.client.send({ t: 'room.start' });
    const error = await bia.client.next('error');

    expect(error.d).toEqual({
      code: 'only_host_can_start',
      message: 'only the host can start',
    });
  });

  it('AC-029: leaving tells the leaver and updates the others @spec:AC-029', async () => {
    const { client: ana } = await login('ANA');
    const room = await createRoom(ana);
    const [bia] = await joinAll(room.code, ['BIA']);
    await state(ana, (s) => s.members.length === 2);

    bia.client.send({ t: 'room.leave' });
    const left = await bia.client.next('room.left');
    const seenByAna = await state(ana, (s) => s.members.length === 1);

    expect(left.d).toEqual({ code: room.code });
    expect(seenByAna.members.map((m: any) => m.nickname)).toEqual(['ANA']);
  });

  it('AC-030: everyone is told when the host role passes on @spec:AC-030', async () => {
    const { client: ana } = await login('ANA');
    const room = await createRoom(ana);
    const [bia, cris] = await joinAll(room.code, ['BIA', 'CRIS']);

    ana.send({ t: 'room.leave' });
    const seenByBia = await state(
      bia.client,
      (s) => s.hostId === bia.session.sessionId,
    );
    const seenByCris = await state(
      cris.client,
      (s) => s.hostId === bia.session.sessionId,
    );

    expect(seenByBia.members).toHaveLength(2);
    expect(seenByCris.hostId).toBe(bia.session.sessionId);
  });

  it('AC-031: the last player leaving deletes the room from the list @spec:AC-031', async () => {
    const { client: ana } = await login('ANA');
    const room = await createRoom(ana);
    const { client: bia } = await login('BIA');

    ana.send({ t: 'room.leave' });
    await ana.next('room.left');
    bia.send({ t: 'room.list' });
    const list = await bia.next('room.list');
    bia.send({ t: 'room.join', d: { code: room.code } });
    const error = await bia.next('error');

    expect(list.d.rooms).toEqual([]);
    expect(error.d.code).toBe('room_not_found');
  });

  it('AC-033: creating another room leaves the first one @spec:AC-033', async () => {
    const { client: ana } = await login('ANA');
    const first = await createRoom(ana);
    const [bia] = await joinAll(first.code, ['BIA']);
    await state(ana, (s) => s.members.length === 2);

    bia.client.send({
      t: 'room.create',
      d: { size: 4, visibility: 'private' },
    });
    const second = await state(bia.client, (s) => s.code !== first.code);
    const seenByAna = await state(ana, (s) => s.members.length === 1);

    expect(second.members).toHaveLength(1);
    expect(seenByAna.code).toBe(first.code);
  });

  it('AC-073: kicking tells the kicked player and updates the others @spec:AC-073', async () => {
    const { client: ana } = await login('ANA');
    const room = await createRoom(ana);
    const [bia, cris] = await joinAll(room.code, ['BIA', 'CRIS']);

    ana.send({ t: 'room.kick', d: { sessionId: bia.session.sessionId } });
    const kicked = await bia.client.next('room.kicked');
    const seenByCris = await state(cris.client, (s) => s.members.length === 2);

    expect(kicked.d).toEqual({
      code: room.code,
      message: 'you were removed from the room',
    });
    expect(seenByCris.members.map((m: any) => m.nickname)).toEqual([
      'ANA',
      'CRIS',
    ]);
  });

  it('AC-073: a member who is not the host cannot kick @spec:AC-073', async () => {
    const { client: ana } = await login('ANA');
    const room = await createRoom(ana);
    const [bia, cris] = await joinAll(room.code, ['BIA', 'CRIS']);

    bia.client.send({
      t: 'room.kick',
      d: { sessionId: cris.session.sessionId },
    });
    const error = await bia.client.next('error');

    expect(error.d).toEqual({
      code: 'only_host_can_kick',
      message: 'only the host can kick',
    });
  });

  it('AC-074: a kicked player cannot rejoin @spec:AC-074', async () => {
    const { client: ana } = await login('ANA');
    const room = await createRoom(ana);
    const [bia] = await joinAll(room.code, ['BIA']);
    ana.send({ t: 'room.kick', d: { sessionId: bia.session.sessionId } });
    await bia.client.next('room.kicked');

    bia.client.send({ t: 'room.join', d: { code: room.code } });
    const error = await bia.client.next('error');

    expect(error.d).toEqual({
      code: 'banned',
      message: 'you were banned from this room',
    });
  });

  it('AC-005: no message to anyone ever carries a session token @spec:AC-005 @principle:P-005', async () => {
    const { client: ana } = await login('ANA');
    const room = await createRoom(ana);
    const [bia] = await joinAll(room.code, ['BIA']);
    ana.send({ t: 'room.settings', d: { rounds: 5 } });
    bia.client.send({ t: 'room.list' });
    await bia.client.next('room.list');
    await state(ana, (s) => s.settings.rounds === 5);
    await sleep(50);

    const everything = JSON.stringify(clients.map((c) => c.messages));
    for (const token of tokens) {
      expect(everything).not.toContain(token);
    }
  });

  it('messages from someone who is not logged in are refused', async () => {
    const client = await connect(url);
    clients.push(client);

    client.send({ t: 'room.create', d: { size: 4, visibility: 'public' } });

    expect((await client.next('error')).d).toEqual({
      code: 'not_authenticated',
    });
  });
});
