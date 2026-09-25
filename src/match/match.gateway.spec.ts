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
    // the tests drive time by hand with matches.tick(); the real 60 Hz loop
    // would add frames of its own while they sleep
    matches.onModuleDestroy();
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

  describe('movement over the wire', () => {
    const FRAME = 1000 / 60;
    const run = (frames: number) => {
      for (let i = 0; i < frames; i++) matches.tick(FRAME);
    };
    // the latest snapshot a client received, optionally waiting for a condition
    const lastSnapshot = async (
      client: TestClient,
      ok: (m: any) => boolean = () => true,
    ) => {
      await sleep(80);
      const all = client.messages.filter(
        (m) => m.t === 'match.snapshot' && ok(m.d),
      );
      return all.at(-1)?.d;
    };
    const me = (snap: any, id: string) =>
      snap.players.find((p: any) => p.id === id);

    it('AC-059: every member receives snapshots about 20 times a second while a round is on @spec:AC-059', async () => {
      const { all } = await startMatch();
      matches.tick(START_MS);
      for (const { client } of all) client.messages.length = 0;

      run(60);
      await sleep(100);

      for (const { client } of all) {
        const count = client.messages.filter(
          (m) => m.t === 'match.snapshot',
        ).length;
        expect(count).toBeGreaterThanOrEqual(19);
        expect(count).toBeLessThanOrEqual(21);
      }
    });

    it('AC-059: a snapshot lists every player with position, facing, animation, life and state @spec:AC-059', async () => {
      const { all } = await startMatch();
      matches.tick(START_MS);
      run(10);

      const snap = await lastSnapshot(all[0].client);

      expect(snap.players).toHaveLength(4);
      for (const p of snap.players) {
        expect(Object.keys(p).sort()).toEqual([
          'anim',
          'id',
          'life',
          'rv',
          'status',
          'x',
          'xs',
          'y',
        ]);
      }
      expect(snap.machines).toHaveLength(7);
      expect(snap.phase).toBe('round');
    });

    it('AC-061: sending "hold right" moves the player 240 px in a second, seen in the snapshots @spec:AC-061', async () => {
      const { all, started } = await startMatch();
      matches.tick(START_MS);
      run(20);
      // the team draw is random: take a worker, who spawns on the left with
      // 240 px of free floor to the right (a capataz starts next to the right wall)
      const workerId = started[0].d.view.players.find(
        (p: any) => p.team === 'workers',
      ).sessionId;
      const mine = all.find((p) => p.session.sessionId === workerId)!;
      const start = me(
        await lastSnapshot(mine.client),
        mine.session.sessionId,
      ).x;

      // 60 frames of "hold right" in two messages (the server reads at most 30
      // inputs per message and keeps 30 waiting), then what a real client does
      // when the key is released: an input with no keys. Without it the server
      // would repeat the held keys for a few frames.
      const held = (from: number) =>
        Array.from({ length: 30 }, (_, i) => ({ seq: from + i, r: 1 }));
      mine.client.send({ t: 'input', d: { inputs: held(1) } });
      await sleep(30);
      run(30);
      mine.client.send({ t: 'input', d: { inputs: held(31) } });
      await sleep(30);
      run(30);
      mine.client.send({ t: 'input', d: { inputs: [{ seq: 61 }] } });
      await sleep(30);
      run(1);
      run(6); // let the next snapshots (every 3rd frame) catch up with the final position
      const end = me(await lastSnapshot(mine.client), mine.session.sessionId).x;

      expect(end - start).toBe(240);
    });

    it('AC-060: the snapshot tells each player the last input number applied for them @spec:AC-060', async () => {
      const { all } = await startMatch();
      matches.tick(START_MS);
      run(5);
      const [a, b] = [all[0], all[1]];

      a.client.send({
        t: 'input',
        d: { inputs: [{ seq: 1, r: 1 }, { seq: 2, r: 1 }, { seq: 3 }] },
      });
      b.client.send({ t: 'input', d: { inputs: [{ seq: 1 }] } });
      await sleep(50);
      run(6);

      expect((await lastSnapshot(a.client)).ack).toBe(3);
      expect((await lastSnapshot(b.client)).ack).toBe(1);
    });

    it('AC-062: a position claimed by the client is ignored, over the wire @spec:AC-062', async () => {
      const { all } = await startMatch();
      matches.tick(START_MS);
      run(20);
      const cheater = all[2];
      const before = me(
        await lastSnapshot(cheater.client),
        cheater.session.sessionId,
      );

      cheater.client.send({
        t: 'input',
        d: {
          inputs: [{ seq: 1, x: 12, y: 34, hspd: 900 }],
          x: 5,
          y: 5,
          position: { x: 1, y: 1 },
        },
      });
      cheater.client.send({ t: 'match.position', d: { x: 12, y: 34 } });
      await sleep(50);
      run(6);
      const after = me(
        await lastSnapshot(cheater.client),
        cheater.session.sessionId,
      );

      // the claimed x=12 / y=34 changed nothing: the one real input (no keys)
      // only let gravity act for a frame
      expect(after.x).toBe(before.x);
      expect(Math.abs(after.y - before.y)).toBeLessThan(1);
      expect(
        cheater.client.messages.some(
          (m) => m.t === 'error' && m.d.code === 'bad_message',
        ),
      ).toBe(true);
    });

    it('AC-062: sending far more inputs than time has passed does not make a player faster @spec:AC-062', async () => {
      const { all } = await startMatch();
      matches.tick(START_MS);
      run(20);
      const mine = all[3];
      const start = me(
        await lastSnapshot(mine.client),
        mine.session.sessionId,
      ).x;

      for (let batch = 0; batch < 8; batch++) {
        mine.client.send({
          t: 'input',
          d: {
            inputs: Array.from({ length: 30 }, (_, i) => ({
              seq: batch * 30 + i + 1,
              r: 1,
            })),
          },
        });
      }
      await sleep(80);
      run(30);
      const end = me(await lastSnapshot(mine.client), mine.session.sessionId).x;

      expect(end - start).toBeLessThanOrEqual(30 * 4);
    });

    it('match.sync restarts the input numbering of a client that reloaded', async () => {
      const { all } = await startMatch();
      matches.tick(START_MS);
      const mine = all[0];
      mine.client.send({
        t: 'input',
        d: { inputs: [{ seq: 1 }, { seq: 2 }, { seq: 3 }] },
      });
      await sleep(40);
      run(5);
      expect((await lastSnapshot(mine.client)).ack).toBe(3);

      mine.client.send({ t: 'match.sync' });
      await sleep(40);
      mine.client.send({ t: 'input', d: { inputs: [{ seq: 1, r: 1 }] } });
      await sleep(40);
      run(6);

      expect((await lastSnapshot(mine.client)).ack).toBe(1);
    });

    describe('combat over the wire', () => {
      const put = (
        code: string,
        id: string,
        x: number,
        y = 896,
        facing: 1 | -1 = 1,
      ) => {
        const b = matches.getSimulation(code)!.bodyOf(id)!;
        b.x = x;
        b.y = y;
        b.vspd = 0;
        b.facing = facing;
      };
      const startRound = async () => {
        const room = await startMatch();
        matches.tick(START_MS);
        run(2);
        const view = room.started[0].d.view;
        const byRole = (role: string) =>
          view.players.find((p: any) => p.role === role).sessionId;
        const client = (id: string) =>
          room.all.find((p) => p.session.sessionId === id)!;
        return { ...room, view, byRole, client };
      };
      const tuckAway = (code: string, view: any, keep: string[]) => {
        view.players
          .filter((p: any) => !keep.includes(p.sessionId))
          .forEach((p: any, i: number) =>
            put(code, p.sessionId, 200 + i * 80, 400),
          );
      };

      it('AC-056: the Owner sends "attack" and the bullet appears in everybody\'s snapshots @spec:AC-056', async () => {
        const { all, code, byRole, client } = await startRound();
        const owner = byRole('owner');
        put(code, owner, 1000, 896, 1);
        for (const { client: c } of all) c.messages.length = 0;

        client(owner).client.send({
          t: 'input',
          d: { inputs: [{ seq: 1, a: 1 }] },
        });
        await sleep(50);
        run(9);
        await sleep(80);

        for (const { client: c } of all) {
          const withBullet = c.messages.filter(
            (m) => m.t === 'match.snapshot' && m.d.bullets.length > 0,
          );
          expect(withBullet.length).toBeGreaterThan(0);
          expect(withBullet[0].d.bullets[0]).toMatchObject({ d: 1 });
        }
      });

      it('AC-056: "attack" from a Policeman or an Operário creates no bullet @spec:AC-056', async () => {
        const { all, code, view, client } = await startRound();
        const others = view.players
          .filter((p: any) => p.role !== 'owner')
          .map((p: any) => p.sessionId);
        others.forEach((id: string, i: number) =>
          put(code, id, 1000 + i * 200),
        );
        for (const { client: c } of all) c.messages.length = 0;

        for (const id of others)
          client(id).client.send({
            t: 'input',
            d: { inputs: [{ seq: 1, a: 1 }] },
          });
        await sleep(50);
        run(9);
        await sleep(80);

        const bullets = all[0].client.messages
          .filter((m) => m.t === 'match.snapshot')
          .flatMap((m) => m.d.bullets);
        expect(bullets).toEqual([]);
      });

      it('AC-058: a hit is judged by the server and the new life reaches every player @spec:AC-058', async () => {
        const { all, code, view, byRole, client } = await startRound();
        const owner = byRole('owner');
        const victim = view.players.find(
          (p: any) => p.team === 'workers',
        ).sessionId;
        tuckAway(code, view, [owner, victim]);
        put(code, owner, 1000, 896, 1);
        put(code, victim, 1100);

        client(owner).client.send({
          t: 'input',
          d: { inputs: [{ seq: 1, a: 1 }] },
        });
        await sleep(50);
        run(20);
        await sleep(80);

        for (const { client: c } of all) {
          const last = c.messages
            .filter((m) => m.t === 'match.snapshot')
            .at(-1)!.d;
          expect(last.players.find((p: any) => p.id === victim).life).toBe(5);
        }
      });

      it('AC-058: a client that reports damage, life or hits by itself is ignored @spec:AC-058', async () => {
        const { code, view, client } = await startRound();
        const cheater = view.players.find(
          (p: any) => p.team === 'workers',
        ).sessionId;
        const target = view.players.find(
          (p: any) => p.team === 'capatazes',
        ).sessionId;
        const before = JSON.stringify(
          matches
            .getMatch(code)!
            .view()
            .players.map((p) => [p.sessionId, p.life, p.status]),
        );

        const forged = [
          {
            t: 'input',
            d: {
              inputs: [
                {
                  seq: 1,
                  a: 1,
                  damage: 999,
                  life: 0,
                  target,
                  hit: target,
                  kill: target,
                },
              ],
              damage: 999,
              target,
            },
          },
          { t: 'combat.hit', d: { target, damage: 6 } },
          { t: 'player.damage', d: { id: target, amount: 6 } },
          { t: 'match.damage', d: { id: target, amount: 6 } },
          { t: 'player.life', d: { life: 0 } },
          { t: 'bullet.hit', d: { target } },
          { t: 'match.revive', d: { id: target } },
        ];
        for (const message of forged) client(cheater).client.send(message);
        await sleep(80);
        run(5);

        const errors = client(cheater).client.messages.filter(
          (m) => m.t === 'error' && m.d.code === 'bad_message',
        );
        expect(errors).toHaveLength(forged.length - 1); // only the real input is understood
        const after = JSON.stringify(
          matches
            .getMatch(code)!
            .view()
            .players.map((p) => [p.sessionId, p.life, p.status]),
        );
        expect(after).toBe(before); // an attack input with nobody in reach hurts nobody
      });

      it('AC-069: holding the interact key over the wire revives a downed teammate @spec:AC-069', async () => {
        const { code, view, client } = await startRound();
        const capatazes = view.players
          .filter((p: any) => p.team === 'capatazes')
          .map((p: any) => p.sessionId);
        const [downed, helper] = capatazes;
        tuckAway(code, view, [downed, helper]);
        put(code, downed, 1000);
        put(code, helper, 1030);
        matches.getMatch(code)!.damage(downed, 6);
        run(2);

        let seq = 0;
        for (let block = 0; block < 6; block++) {
          client(helper).client.send({
            t: 'input',
            d: {
              inputs: Array.from({ length: 30 }, () => ({ seq: ++seq, e: 1 })),
            },
          });
          await sleep(30);
          run(30);
        }
        run(6); // snapshots go out every 3rd frame: let one show the final state
        await sleep(80);

        const last = client(helper)
          .client.messages.filter((m) => m.t === 'match.snapshot')
          .at(-1)!.d;
        const revived = last.players.find((p: any) => p.id === downed);
        expect(revived.status).toBe('active');
        expect(revived.life).toBe(2);
      });
    });

    it('AC-005: snapshots never carry a session token @spec:AC-005 @principle:P-005', async () => {
      const { all } = await startMatch();
      matches.tick(START_MS);
      run(30);
      await sleep(80);

      const snapshots = clients.flatMap((c) =>
        c.messages.filter((m) => m.t === 'match.snapshot'),
      );
      expect(snapshots.length).toBeGreaterThan(0);
      for (const token of tokens) {
        expect(JSON.stringify(snapshots)).not.toContain(token);
      }
      expect(all).toHaveLength(4);
    });
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
