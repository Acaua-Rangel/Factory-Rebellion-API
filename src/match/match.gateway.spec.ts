import { INestApplication } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import {
  connect,
  sleep,
  startApp,
  TestClient,
} from '../realtime/realtime-test-utils';
import { RoomsModule } from '../rooms/rooms.module';
import { SessionModule } from '../session/session.module';
import { Session, SessionService } from '../session/session.service';
import { INTERMISSION_MS, RESULT_MS, START_MS } from './match-state';
import { MatchModule } from './match.module';
import { MatchService } from './match.service';

interface Client {
  session: Session;
  client: TestClient;
}

describe('Match messages over the WebSocket', () => {
  let app: INestApplication;
  let url: string;
  let sessions: SessionService;
  let matches: MatchService;
  const clients: TestClient[] = [];
  const tokens: string[] = [];

  const login = async (nickname: string): Promise<Client> => {
    const session = sessions.create(nickname);
    tokens.push(session.token);
    const client = await connect(url);
    clients.push(client);
    client.send({ t: 'hello', d: { token: session.token } });
    await client.next('welcome');
    return { session, client };
  };

  // Four players in a full room; the host has not started yet.
  const fullRoom = async () => {
    const host = await login('ANA');
    host.client.send({
      t: 'room.create',
      d: { size: 4, visibility: 'public', rounds: 4 },
    });
    const code = (await host.client.next('room.state')).d.code as string;
    const others: Client[] = [];
    for (const name of ['BIA', 'CRIS', 'DANI']) {
      const p = await login(name);
      p.client.send({ t: 'room.join', d: { code } });
      await p.client.next('room.state');
      others.push(p);
    }
    return { host, others, all: [host, ...others], code };
  };

  const startMatch = async () => {
    const room = await fullRoom();
    room.host.client.send({ t: 'room.start' });
    const started = await Promise.all(
      room.all.map((p) => p.client.next('match.started')),
    );
    return { ...room, started };
  };

  const workerIds = (view: any) =>
    view.players
      .filter((p: any) => p.team === 'workers')
      .map((p: any) => p.sessionId);
  const breakAllMachines = (code: string) => {
    matches
      .getMatch(code)!
      .view()
      .machines.forEach((m) => matches.machineBroken(code, m.id));
    matches.tick(16);
  };

  beforeEach(async () => {
    ({ app, url } = await startApp([
      SessionModule,
      RealtimeModule,
      RoomsModule,
      MatchModule,
    ]));
    sessions = app.get(SessionService);
    matches = app.get(MatchService);
  });

  afterEach(async () => {
    clients.splice(0).forEach((c) => c.socket.terminate());
    tokens.length = 0;
    await app.close();
  });

  it('AC-034: every member is told the drawn teams when the match starts @spec:AC-034', async () => {
    const { started } = await startMatch();

    for (const message of started) {
      const { view } = message.d;
      expect(view.phase).toBe('starting');
      expect(view.players).toHaveLength(4);
      expect(
        view.players.filter((p: any) => p.team === 'workers'),
      ).toHaveLength(2);
      expect(
        view.players.filter((p: any) => p.team === 'capatazes'),
      ).toHaveLength(2);
    }
    // everyone got the same draw
    expect(started[1].d.view.players).toEqual(started[0].d.view.players);
  });

  it('AC-035: the drawn roles reach the players: one Owner, the rest Policemen, workers with a look @spec:AC-035', async () => {
    const { started } = await startMatch();

    const { players } = started[0].d.view;
    expect(players.filter((p: any) => p.role === 'owner')).toHaveLength(1);
    expect(players.filter((p: any) => p.role === 'policeman')).toHaveLength(1);
    expect(
      players
        .filter((p: any) => p.team === 'workers')
        .map((p: any) => p.look)
        .sort(),
    ).toEqual(['op1', 'op2']);
  });

  it('AC-036: round 1 starts after the countdown with the clock at 60 seconds @spec:AC-036', async () => {
    const { all, code } = await startMatch();

    matches.tick(START_MS);

    for (const { client } of all) {
      const message = await client.next('match.round_started');
      expect(message.d).toMatchObject({ round: 1, suddenDeath: false });
      expect(message.d.view.timeLeftMs).toBe(60_000);
      expect(
        message.d.view.players.every(
          (p: any) => p.status === 'active' && p.life === 6,
        ),
      ).toBe(true);
    }
    expect(matches.getMatch(code)!.view().phase).toBe('round');
  });

  it('AC-037/AC-040: when the workers break every machine everyone sees the round winner and the score @spec:AC-040', async () => {
    const { all, code } = await startMatch();
    matches.tick(START_MS);

    breakAllMachines(code);

    for (const { client } of all) {
      const message = await client.next('match.round_ended');
      expect(message.d).toEqual({
        winner: 'workers',
        reason: 'machines',
        score: { workers: 1, capatazes: 0 },
        roundsPlayed: 1,
        nextInMs: INTERMISSION_MS,
      });
    }
  });

  it('AC-042: a tie at the round limit is announced as sudden death @spec:AC-042', async () => {
    const { all, code } = await startMatch();
    matches.tick(START_MS);
    for (const winner of ['workers', 'capatazes', 'workers', 'capatazes']) {
      if (winner === 'workers') breakAllMachines(code);
      else matches.tick(60_000);
      matches.tick(INTERMISSION_MS);
    }

    for (const { client } of all) {
      await client.next('match.sudden_death');
      // skip the round_started of rounds 1-4: the sudden death one has no clock
      let started;
      do {
        started = await client.next('match.round_started');
      } while (!started.d.suddenDeath);
      expect(started.d.round).toBeNull();
      expect(started.d.view.timeLeftMs).toBeNull();
    }
  });

  it('AC-045: everyone sees the final result, then the room is back in the lobby with the same members @spec:AC-045', async () => {
    const { all, code, host } = await startMatch();
    matches.tick(START_MS);
    breakAllMachines(code);
    matches.tick(INTERMISSION_MS);
    breakAllMachines(code);

    for (const { client } of all) {
      const ended = await client.next('match.ended');
      expect(ended.d).toEqual({
        winner: 'workers',
        reason: 'score',
        score: { workers: 2, capatazes: 0 },
      });
    }
    matches.tick(RESULT_MS);

    for (const { client } of all) {
      // older room.state messages (the room filling up) are still queued:
      // wait for the "lobby" that comes after the "match" phase
      let state: any;
      let sawMatch = false;
      do {
        state = (await client.next('room.state')).d;
        sawMatch = sawMatch || state.phase === 'match';
      } while (!(sawMatch && state.phase === 'lobby'));
      expect(state.hostId).toBe(host.session.sessionId);
      expect(state.members).toHaveLength(4);
    }
  });

  it('AC-046: when a whole team quits the others are told it ended by walkover @spec:AC-046', async () => {
    const { host, others, all, started } = await startMatch();
    matches.tick(START_MS);
    const workers = workerIds(started[0].d.view);
    const quitting = all.filter((p) => workers.includes(p.session.sessionId));
    const staying = all.filter((p) => !workers.includes(p.session.sessionId));

    for (const p of quitting) p.client.send({ t: 'room.leave' });
    await sleep(100);
    matches.tick(16);

    for (const { client } of staying) {
      const ended = await client.next('match.ended');
      expect(ended.d).toMatchObject({
        winner: 'capatazes',
        reason: 'walkover',
      });
    }
    expect(host && others).toBeTruthy();
  });

  it('AC-072: players still in the match are told when a newcomer takes an open seat @spec:AC-072', async () => {
    const { all, code, started } = await startMatch();
    matches.tick(START_MS);
    const leaver = all[3];
    leaver.client.send({ t: 'room.leave' });
    await leaver.client.next('room.left');
    const newcomer = await login('LATE');

    newcomer.client.send({ t: 'room.join', d: { code } });
    await sleep(100);
    matches.tick(16);

    for (const { client } of all.slice(0, 3)) {
      const left = await client.next('match.player_left');
      expect(left.d).toEqual({ sessionId: leaver.session.sessionId });
      const joined = await client.next('match.player_joined');
      expect(joined.d.player).toMatchObject({
        sessionId: newcomer.session.sessionId,
        nickname: 'LATE',
        status: 'spectating',
      });
    }
    expect(
      started[3].d.view.players.find(
        (p: any) => p.sessionId === leaver.session.sessionId,
      ).team,
    ).toBe(
      matches
        .getMatch(code)!
        .view()
        .players.find((p) => p.sessionId === newcomer.session.sessionId)!.team,
    );
  });

  it('a player who reconnects asks for the match and gets the current state (match.sync)', async () => {
    const { all } = await startMatch();
    matches.tick(START_MS);

    all[1].client.send({ t: 'match.sync' });
    const state = await all[1].client.next('match.state');

    expect(state.d.view.phase).toBe('round');
    expect(state.d.view.players).toHaveLength(4);
  });

  it('match.sync outside of a match answers with no match', async () => {
    const { client } = await login('SOLO');

    client.send({ t: 'match.sync' });
    const state = await client.next('match.state');

    expect(state.d).toEqual({ view: null });
  });

  it('P-003: nothing a client sends can change the match: the server is the only judge @principle:P-003', async () => {
    const { all, code } = await startMatch();
    matches.tick(START_MS);
    // the real 60 Hz clock keeps running during the test: compare all but the clock
    const withoutClock = () => {
      const { timeLeftMs, ...rest } = matches.getMatch(code)!.view();
      return { clockRunning: typeof timeLeftMs === 'number', ...rest };
    };
    const before = withoutClock();
    const cheater = all[0].client;

    // a client claiming results, scores, life, machines, positions or a new phase
    const forged = [
      {
        t: 'match.round_ended',
        d: {
          winner: 'workers',
          reason: 'machines',
          score: { workers: 9, capatazes: 0 },
        },
      },
      {
        t: 'match.ended',
        d: {
          winner: 'workers',
          reason: 'score',
          score: { workers: 9, capatazes: 0 },
        },
      },
      {
        t: 'match.state',
        d: { view: { phase: 'finished', score: { workers: 9, capatazes: 0 } } },
      },
      { t: 'match.round_started', d: { round: 99, suddenDeath: true } },
      { t: 'match.sudden_death', d: {} },
      { t: 'match.player_down', d: { sessionId: all[1].session.sessionId } },
      { t: 'machine.broken', d: { id: 'machine1' } },
      { t: 'player.life', d: { life: 999 } },
      { t: 'player.position', d: { x: 1, y: 1 } },
      { t: 'room.started', d: { code } },
      {
        t: 'match.sync',
        d: {
          view: { score: { workers: 9, capatazes: 0 } },
          score: { workers: 9, capatazes: 0 },
        },
      },
    ];
    for (const message of forged) cheater.send(message);
    await sleep(150);

    const errors = cheater.messages.filter((m) => m.t === 'error');
    // every forged message except the harmless sync was refused as unknown
    expect(errors).toHaveLength(forged.length - 1);
    expect(errors.every((e) => e.d.code === 'bad_message')).toBe(true);
    // match.sync is answered with the REAL state, whatever the client claimed
    const answered = await cheater.next('match.state');
    expect(answered.d.view.score).toEqual({ workers: 0, capatazes: 0 });
    expect(withoutClock()).toEqual(before);
  });

  it('AC-005: no message of the whole match ever carries a session token @spec:AC-005 @principle:P-005', async () => {
    const { all, code } = await startMatch();
    matches.tick(START_MS);
    breakAllMachines(code);
    matches.tick(INTERMISSION_MS);
    breakAllMachines(code);
    all[0].client.send({ t: 'match.sync' });
    await all[0].client.next('match.state');
    await sleep(100);

    const everything = JSON.stringify(clients.map((c) => c.messages));
    expect(everything).toContain('match.ended'); // the match really ran
    for (const token of tokens) {
      expect(everything).not.toContain(token);
    }
  });
});
