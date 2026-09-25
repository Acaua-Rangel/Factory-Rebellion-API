import { JoinLimiter } from '../rooms/join-limiter';
import { RoomsService } from '../rooms/rooms.service';
import { PublicSession } from '../session/session.service';
import {
  INTERMISSION_MS,
  MatchEvent,
  MatchView,
  RESULT_MS,
  ROUND_MS,
  START_MS,
} from './match-state';
import { MatchService, MatchServiceEvent } from './match.service';

const player = (id: string): PublicSession => ({
  sessionId: id,
  nickname: id.toUpperCase(),
});

type Seen = { code: string; event: MatchServiceEvent };

describe('MatchService', () => {
  let rooms: RoomsService;
  let matches: MatchService;
  let seen: Seen[];
  let code: string;

  beforeEach(() => {
    rooms = new RoomsService(new JoinLimiter());
    matches = new MatchService(rooms);
    seen = [];
    matches.onEvent((c, event) => seen.push({ code: c, event }));
    code = rooms.createRoom(player('p1'), {
      size: 4,
      visibility: 'public',
      rounds: 4,
    }).code;
    for (const id of ['p2', 'p3', 'p4']) rooms.join(player(id), code);
  });

  // snapshots have their own tests below; here we follow the rules' events
  const types = () =>
    seen.map((s) => s.event.type).filter((type) => type !== 'snapshot');
  const machineIds = () =>
    matches
      .getMatch(code)!
      .view()
      .machines.map((m) => m.id);
  const workersWinRound = () => {
    machineIds().forEach((id) => matches.machineBroken(code, id));
    matches.tick(16);
  };

  it('AC-034: starting the room starts a match with the room members drawn into two teams @spec:AC-034', () => {
    rooms.start('p1');

    const view = matches.getMatch(code)!.view();
    expect(view.phase).toBe('starting');
    expect(view.roundLimit).toBe(4);
    expect(view.players.map((p) => p.sessionId).sort()).toEqual([
      'p1',
      'p2',
      'p3',
      'p4',
    ]);
    expect(view.players.filter((p) => p.team === 'workers')).toHaveLength(2);
    expect(view.players.filter((p) => p.team === 'capatazes')).toHaveLength(2);
    expect(seen).toEqual([
      {
        code,
        event: {
          type: 'started',
          view: expect.objectContaining({ roomCode: code }),
        },
      },
    ]);
  });

  it('the room setting for rounds decides when sudden death comes', () => {
    rooms.updateSettings('p1', { rounds: 6 });
    rooms.start('p1');

    expect(matches.getMatch(code)!.view().roundLimit).toBe(6);
  });

  it('AC-036: the clock advances the countdown and starts round 1 @spec:AC-036', () => {
    rooms.start('p1');

    matches.tick(START_MS);

    expect(matches.getMatch(code)!.view().phase).toBe('round');
    expect(types()).toEqual(['started', 'round_started']);
  });

  it('a room that has not started has no match', () => {
    expect(matches.getMatch(code)).toBeUndefined();
    matches.tick(1000);
    expect(seen).toEqual([]);
  });

  it('AC-045: after the result screen the match closes and the room is back in the lobby, same members and host @spec:AC-045', () => {
    rooms.start('p1');
    matches.tick(START_MS);
    workersWinRound();
    matches.tick(INTERMISSION_MS);
    workersWinRound(); // 2-0: match over
    expect(types()).toContain('match_ended');
    expect(rooms.getRoom(code)?.phase).toBe('match');

    matches.tick(RESULT_MS - 1);
    expect(rooms.getRoom(code)?.phase).toBe('match');
    matches.tick(1);

    const room = rooms.getRoom(code)!;
    expect(room.phase).toBe('lobby');
    expect(room.hostId).toBe('p1');
    expect(room.members.map((m) => m.sessionId)).toEqual([
      'p1',
      'p2',
      'p3',
      'p4',
    ]);
    expect(matches.getMatch(code)).toBeUndefined();
    expect(types().at(-1)).toBe('closed');
  });

  it('AC-045: the same room can play another match right away @spec:AC-045', () => {
    rooms.start('p1');
    matches.tick(START_MS);
    workersWinRound();
    matches.tick(INTERMISSION_MS);
    workersWinRound();
    matches.tick(RESULT_MS);

    rooms.start('p1');

    expect(matches.getMatch(code)!.view().phase).toBe('starting');
    expect(matches.getMatch(code)!.view().score).toEqual({
      workers: 0,
      capatazes: 0,
    });
  });

  it('AC-046: players leaving the room take the team down by walkover @spec:AC-046', () => {
    rooms.start('p1');
    matches.tick(START_MS);
    const workers = matches
      .getMatch(code)!
      .view()
      .players.filter((p) => p.team === 'workers');

    workers.forEach((w) => rooms.leave(w.sessionId));
    matches.tick(16);

    expect(
      seen.find((s) => s.event.type === 'match_ended')?.event,
    ).toMatchObject({
      winner: 'capatazes',
      reason: 'walkover',
    });
  });

  it('AC-046: a player whose connection expired counts as gone @spec:AC-046', () => {
    rooms.start('p1');
    matches.tick(START_MS);
    const workers = matches
      .getMatch(code)!
      .view()
      .players.filter((p) => p.team === 'workers');

    workers.forEach((w) => rooms.removeSession(w.sessionId));
    matches.tick(16);

    expect(types()).toContain('match_ended');
  });

  it('AC-072: someone joining a room with an open seat takes it in the match @spec:AC-072', () => {
    rooms.start('p1');
    matches.tick(START_MS);
    const leaver = matches
      .getMatch(code)!
      .view()
      .players.find((p) => p.sessionId === 'p4')!;
    rooms.leave('p4');

    rooms.join(player('late'), code);
    matches.tick(16);

    const joined = seen.find((s) => s.event.type === 'player_joined')!
      .event as Extract<MatchEvent, { type: 'player_joined' }>;
    expect(joined.player).toMatchObject({
      sessionId: 'late',
      team: leaver.team,
      role: leaver.role,
      look: leaver.look,
      status: 'spectating',
    });
    expect(matches.getMatch(code)!.view().players).toHaveLength(4);
  });

  it('AC-072: the newcomer plays from the next round on @spec:AC-072', () => {
    rooms.start('p1');
    matches.tick(START_MS);
    rooms.leave('p4');
    rooms.join(player('late'), code);
    matches.tick(ROUND_MS); // capatazes hold out
    matches.tick(INTERMISSION_MS);

    const late = matches
      .getMatch(code)!
      .view()
      .players.find((p) => p.sessionId === 'late')!;
    expect(late.status).toBe('active');
  });

  it('a room emptied during the match drops the match', () => {
    rooms.start('p1');
    for (const id of ['p1', 'p2', 'p3', 'p4']) rooms.leave(id);

    expect(matches.getMatch(code)).toBeUndefined();
    matches.tick(1000); // nothing left to run, nothing breaks
  });

  it('lets other features report what happened (machines, falls) by room code', () => {
    rooms.start('p1');
    matches.tick(START_MS);
    const victim = matches.getMatch(code)!.view().players[0].sessionId;

    matches.playerDown(code, victim);
    matches.machineBroken(code, machineIds()[0]);
    matches.tick(16);

    const view = matches.getMatch(code)!.view();
    expect(view.players.find((p) => p.sessionId === victim)!.status).toBe(
      'incapacitated',
    );
    expect(view.machines[0].broken).toBe(true);
    expect(() => matches.playerDown('ZZZZ-ZZZZ', 'nobody')).not.toThrow();
    expect(() => matches.machineBroken('ZZZZ-ZZZZ', 'm')).not.toThrow();
  });

  it('finds the match a player is in, for reconnects and syncs', () => {
    rooms.start('p1');

    expect(matches.viewFor('p3')?.roomCode).toBe(code);
    expect(matches.viewFor('stranger')).toBeNull();
  });

  describe('movement and snapshots', () => {
    const FRAME = 1000 / 60;
    const run = (frames: number) => {
      for (let i = 0; i < frames; i++) matches.tick(FRAME);
    };
    const startRound = () => {
      rooms.start('p1');
      matches.tick(START_MS);
    };
    const someone = () =>
      matches
        .getMatch(code)!
        .view()
        .players.find((p) => p.team === 'workers')!;
    const snapshots = () =>
      seen
        .filter((s) => s.event.type === 'snapshot')
        .map(
          (s) => s.event as Extract<MatchServiceEvent, { type: 'snapshot' }>,
        );

    it('AC-061: every player gets a body at their spawn when the round starts @spec:AC-061', () => {
      startRound();

      const sim = matches.getSimulation(code)!;
      for (const p of matches.getMatch(code)!.view().players) {
        expect(sim.bodyOf(p.sessionId)!.x).toBe(p.position.x);
      }
    });

    it('AC-061: holding right for 60 frames moves the player 240 px, and the match view follows @spec:AC-061', () => {
      startRound();
      const me = someone();
      run(20); // settle on the floor
      const x0 = matches.getSimulation(code)!.bodyOf(me.sessionId)!.x;

      for (let batch = 0; batch < 2; batch++) {
        matches.enqueueInput(me.sessionId, {
          inputs: Array.from({ length: 30 }, (_, i) => ({
            seq: batch * 30 + i + 1,
            r: 1,
          })),
        });
        run(30);
      }

      expect(matches.getSimulation(code)!.bodyOf(me.sessionId)!.x).toBe(
        x0 + 240,
      );
      expect(
        matches
          .getMatch(code)!
          .view()
          .players.find((p) => p.sessionId === me.sessionId)!.position.x,
      ).toBe(x0 + 240);
    });

    it('AC-062: the client cannot move faster by sending inputs early @spec:AC-062', () => {
      startRound();
      const me = someone();
      run(20);
      const x0 = matches.getSimulation(code)!.bodyOf(me.sessionId)!.x;

      for (let i = 0; i < 6; i++) {
        matches.enqueueInput(me.sessionId, {
          inputs: Array.from({ length: 30 }, (_, k) => ({
            seq: i * 30 + k + 1,
            r: 1,
          })),
        });
      }
      run(30);

      expect(
        matches.getSimulation(code)!.bodyOf(me.sessionId)!.x,
      ).toBeLessThanOrEqual(x0 + 30 * 4);
    });

    it('AC-062: inputs from someone who is not in a match are ignored @spec:AC-062', () => {
      startRound();

      expect(() =>
        matches.enqueueInput('stranger', { inputs: [{ seq: 1, r: 1 }] }),
      ).not.toThrow();
    });

    it('AC-059: snapshots go out 20 times a second while a round is on @spec:AC-059', () => {
      startRound();
      seen.length = 0;

      run(60);

      expect(snapshots().length).toBeGreaterThanOrEqual(19);
      expect(snapshots().length).toBeLessThanOrEqual(21);
    });

    it('AC-059: no snapshots during the countdown, the breaks or after the match @spec:AC-059', () => {
      rooms.start('p1');
      seen.length = 0;
      run(100); // countdown is 3 s = 180 frames: still counting
      expect(snapshots()).toEqual([]);

      matches.tick(START_MS);
      matches.tick(ROUND_MS); // capatazes hold out: break
      seen.length = 0;
      run(60);
      expect(snapshots()).toEqual([]);
    });

    it('AC-059: a snapshot carries every player, the clock and the acknowledged input of each @spec:AC-059 @spec:AC-060', () => {
      startRound();
      const me = someone();
      matches.enqueueInput(me.sessionId, {
        inputs: [
          { seq: 1, r: 1 },
          { seq: 2, r: 1 },
          { seq: 3, r: 1 },
        ],
      });
      seen.length = 0;

      run(12);
      const last = snapshots().at(-1)!;

      expect(last.snapshot.players).toHaveLength(4);
      expect(last.snapshot.phase).toBe('round');
      expect(last.snapshot.timeLeftMs).toBeLessThan(ROUND_MS);
      expect(last.acks[me.sessionId]).toBe(3);
      expect(
        last.acks[
          someone().sessionId === me.sessionId ? 'p1' : someone().sessionId
        ],
      ).toBeDefined();
    });

    it('AC-059: the server frame number in the snapshots keeps going up @spec:AC-059', () => {
      startRound();
      seen.length = 0;

      run(30);
      const ticks = snapshots().map((s) => s.snapshot.tick);

      expect(ticks.length).toBeGreaterThan(3);
      expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
      expect(new Set(ticks).size).toBe(ticks.length);
    });

    it('a stall does not run more than a quarter second of physics in one go', () => {
      startRound();
      const sim = matches.getSimulation(code)!;
      const before = sim.frame;

      matches.tick(10_000);

      expect(sim.frame - before).toBeLessThanOrEqual(15);
    });

    it('a new round puts every body back at its spawn', () => {
      startRound();
      const me = someone();
      run(20);
      matches.enqueueInput(me.sessionId, {
        inputs: Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, r: 1 })),
      });
      run(20);
      const moved = matches.getSimulation(code)!.bodyOf(me.sessionId)!.x;
      expect(moved).not.toBe(me.position.x);

      matches.tick(ROUND_MS);
      matches.tick(INTERMISSION_MS); // round 2

      expect(matches.getSimulation(code)!.bodyOf(me.sessionId)!.x).toBe(
        me.position.x,
      );
    });

    it('players cannot move between rounds, and their inputs are acknowledged and dropped', () => {
      startRound();
      const me = someone();
      matches.tick(ROUND_MS); // break
      const x0 = matches.getSimulation(code)!.bodyOf(me.sessionId)!.x;

      matches.enqueueInput(me.sessionId, {
        inputs: [
          { seq: 1, r: 1 },
          { seq: 2, r: 1 },
        ],
      });
      run(10);

      expect(matches.getSimulation(code)!.bodyOf(me.sessionId)!.x).toBe(x0);
      expect(matches.getSimulation(code)!.ackOf(me.sessionId)).toBe(2);
    });

    it('a player who is down cannot move until the next round', () => {
      startRound();
      const me = someone();
      run(20);
      matches.playerDown(code, me.sessionId);
      run(2);
      const x0 = matches.getSimulation(code)!.bodyOf(me.sessionId)!.x;

      matches.enqueueInput(me.sessionId, { inputs: [{ seq: 1, r: 1 }] });
      run(5);

      expect(matches.getSimulation(code)!.bodyOf(me.sessionId)!.x).toBe(x0);
    });

    it('a player who leaves loses their body; a newcomer gets one at the next round', () => {
      startRound();
      rooms.leave('p4');
      matches.tick(16);
      expect(matches.getSimulation(code)!.bodyOf('p4')).toBeUndefined();

      rooms.join(player('late'), code);
      matches.tick(16);
      matches.tick(ROUND_MS);
      matches.tick(INTERMISSION_MS);

      expect(matches.getSimulation(code)!.bodyOf('late')).toBeDefined();
    });

    it('resyncing lets a reloaded client count its inputs from 1 again', () => {
      startRound();
      const me = someone();
      matches.enqueueInput(me.sessionId, {
        inputs: [
          { seq: 1, r: 1 },
          { seq: 2, r: 1 },
          { seq: 3, r: 1 },
        ],
      });
      run(5);
      expect(matches.getSimulation(code)!.ackOf(me.sessionId)).toBe(3);

      matches.resyncInputs(me.sessionId);
      matches.enqueueInput(me.sessionId, { inputs: [{ seq: 1, r: 1 }] });
      run(1);

      expect(matches.getSimulation(code)!.ackOf(me.sessionId)).toBe(1);
    });

    it('the simulation is dropped when the match closes', () => {
      startRound();
      matches.tick(ROUND_MS);
      matches.tick(INTERMISSION_MS);
      matches.tick(ROUND_MS);
      // 0-2: the capatazes won twice
      matches.tick(RESULT_MS);

      expect(matches.getSimulation(code)).toBeUndefined();
    });
  });

  describe('combat', () => {
    const FRAME = 1000 / 60;
    const run = (frames: number) => {
      for (let i = 0; i < frames; i++) matches.tick(FRAME);
    };
    const players = () => matches.getMatch(code)!.view().players;
    const ownerId = () => players().find((p) => p.role === 'owner')!.sessionId;
    const someoneOf = (team: string, not?: string) =>
      players().find((p) => p.team === team && p.sessionId !== not)!;
    const put = (id: string, x: number, y = 896, facing: 1 | -1 = 1) => {
      const b = matches.getSimulation(code)!.bodyOf(id)!;
      b.x = x;
      b.y = y;
      b.vspd = 0;
      b.facing = facing;
    };
    const lifeOf = (id: string) =>
      players().find((p) => p.sessionId === id)!.life;
    const statusOf = (id: string) =>
      players().find((p) => p.sessionId === id)!.status;
    const snapshots = () =>
      seen
        .filter((s) => s.event.type === 'snapshot')
        .map(
          (s) => s.event as Extract<MatchServiceEvent, { type: 'snapshot' }>,
        );
    beforeEach(() => {
      rooms.start('p1');
      matches.tick(START_MS);
      run(2);
    });

    it('AC-056: an attack input from the Owner puts a bullet in the world, seen in the next snapshot @spec:AC-056', () => {
      const owner = ownerId();
      put(owner, 1000, 896, 1);
      seen.length = 0;

      matches.enqueueInput(owner, { inputs: [{ seq: 1, a: 1 }] });
      run(6);

      const last = snapshots().at(-1)!;
      expect(last.snapshot.bullets.length).toBe(1);
      expect(last.snapshot.bullets[0].d).toBe(1);
    });

    it('AC-056: the same attack from a Policeman or an Operário never makes a bullet @spec:AC-056', () => {
      const other = players().find(
        (p) => p.role === 'policeman' || p.role === 'worker',
      )!.sessionId;
      put(other, 1000);

      matches.enqueueInput(other, { inputs: [{ seq: 1, a: 1 }] });
      run(6);

      expect(snapshots().at(-1)?.snapshot.bullets ?? []).toEqual([]);
    });

    it('AC-058: the bullet takes life from the enemy in front, and everybody sees it @spec:AC-058', () => {
      const owner = ownerId();
      const victim = someoneOf('workers').sessionId;
      put(owner, 1000, 896, 1);
      put(victim, 1100);
      // the other two players stay out of the way
      players()
        .filter((p) => ![owner, victim].includes(p.sessionId))
        .forEach((p, i) => put(p.sessionId, 200 + i * 80, 400));

      matches.enqueueInput(owner, { inputs: [{ seq: 1, a: 1 }] });
      run(15);

      expect(lifeOf(victim)).toBe(5);
      const snap = snapshots().at(-1)!.snapshot;
      expect(snap.players.find((p) => p.id === victim)!.life).toBe(5);
    });

    it('AC-052: enough hits incapacitate: they cannot move or attack, and they fall to the ground @spec:AC-052', () => {
      const attacker = someoneOf('workers').sessionId;
      const victim = someoneOf('capatazes', ownerId()).sessionId;
      players()
        .filter((p) => ![attacker, victim].includes(p.sessionId))
        .forEach((p, i) => put(p.sessionId, 200 + i * 80, 400));
      put(attacker, 1000, 896, 1);
      put(victim, 1060, 896, 1);

      for (let hit = 0; hit < 3; hit++) {
        matches.enqueueInput(attacker, { inputs: [{ seq: hit + 1, a: 1 }] });
        run(31);
      }
      expect(statusOf(victim)).toBe('incapacitated');
      expect(lifeOf(victim)).toBe(0);

      const x0 = matches.getSimulation(code)!.bodyOf(victim)!.x;
      matches.enqueueInput(victim, {
        inputs: Array.from({ length: 10 }, (_, i) => ({
          seq: i + 1,
          r: 1,
          a: 1,
        })),
      });
      run(20);
      expect(matches.getSimulation(code)!.bodyOf(victim)!.x).toBe(x0);
      expect(lifeOf(attacker)).toBe(6); // the downed player's attacks did nothing
    });

    it('AC-054: hits between teammates do nothing @spec:AC-054', () => {
      const a = someoneOf('workers').sessionId;
      const b = someoneOf('workers', a).sessionId;
      players()
        .filter((p) => ![a, b].includes(p.sessionId))
        .forEach((p, i) => put(p.sessionId, 200 + i * 80, 400));
      put(a, 1000, 896, 1);
      put(b, 1030, 896, 1);

      matches.enqueueInput(a, { inputs: [{ seq: 1, a: 1 }] });
      run(5);

      expect(lifeOf(b)).toBe(6);
    });

    it('AC-069: holding the interact key next to a downed teammate for 3 seconds brings them back with 1 heart @spec:AC-069', () => {
      const downed = someoneOf('capatazes').sessionId;
      const helper = someoneOf('capatazes', downed).sessionId;
      players()
        .filter((p) => ![downed, helper].includes(p.sessionId))
        .forEach((p, i) => put(p.sessionId, 200 + i * 80, 400));
      put(downed, 1000);
      put(helper, 1030);
      matches.getMatch(code)!.damage(downed, 6);
      run(2);

      let seq = 0;
      for (let block = 0; block < 6; block++) {
        matches.enqueueInput(helper, {
          inputs: Array.from({ length: 30 }, () => ({ seq: ++seq, e: 1 })),
        });
        run(30);
      }

      expect(statusOf(downed)).toBe('active');
      expect(lifeOf(downed)).toBe(2);
    });

    it('AC-069: the progress shows in the snapshots while the revive is under way @spec:AC-069', () => {
      const downed = someoneOf('capatazes').sessionId;
      const helper = someoneOf('capatazes', downed).sessionId;
      players()
        .filter((p) => ![downed, helper].includes(p.sessionId))
        .forEach((p, i) => put(p.sessionId, 200 + i * 80, 400));
      put(downed, 1000);
      put(helper, 1030);
      matches.getMatch(code)!.damage(downed, 6);
      run(2);
      seen.length = 0;

      matches.enqueueInput(helper, {
        inputs: Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, e: 1 })),
      });
      run(30);

      const rv = snapshots()
        .at(-1)!
        .snapshot.players.find((p) => p.id === downed)!.rv;
      expect(rv).toBeGreaterThan(0.1);
      expect(rv).toBeLessThan(0.25);
    });

    it('AC-053: a new round brings everyone back on their feet with full life and no bullets @spec:AC-053', () => {
      const owner = ownerId();
      const victim = someoneOf('workers').sessionId;
      put(owner, 1000, 896, 1);
      put(victim, 1100);
      matches.enqueueInput(owner, { inputs: [{ seq: 1, a: 1 }] });
      run(15);
      matches.getMatch(code)!.damage(victim, 6);

      matches.tick(ROUND_MS);
      matches.tick(INTERMISSION_MS);

      expect(statusOf(victim)).toBe('active');
      expect(lifeOf(victim)).toBe(6);
      expect(matches.getCombat(code)!.bullets).toEqual([]);
    });

    it('AC-053: a bullet still in flight when the round ends does not carry over to the next one @spec:AC-053', () => {
      const owner = ownerId();
      put(owner, 1500, 896, -1); // shooting into open space: nothing to hit
      players()
        .filter((p) => p.sessionId !== owner)
        .forEach((p, i) => put(p.sessionId, 1900 - i * 70, 400));
      matches.enqueueInput(owner, { inputs: [{ seq: 1, a: 1 }] });
      run(3);
      expect(matches.getCombat(code)!.bullets).toHaveLength(1);

      matches.tick(ROUND_MS); // the round ends by the clock
      matches.tick(INTERMISSION_MS); // and the next one starts

      expect(matches.getMatch(code)!.view().round).toBe(2);
      expect(matches.getCombat(code)!.bullets).toEqual([]);
    });

    it("AC-055: a downed player's inputs are still acknowledged, so the client does not pile them up @spec:AC-055", () => {
      const victim = someoneOf('workers').sessionId;
      matches.getMatch(code)!.damage(victim, 6);
      run(2);

      matches.enqueueInput(victim, {
        inputs: [
          { seq: 1, r: 1 },
          { seq: 2, a: 1 },
          { seq: 3, e: 1 },
        ],
      });
      run(5);

      expect(matches.getSimulation(code)!.ackOf(victim)).toBe(3);
    });

    it('a player who leaves leaves no combat state behind', () => {
      rooms.leave('p4');
      matches.tick(16);

      expect(() => run(5)).not.toThrow();
    });
  });

  describe('the game loop', () => {
    afterEach(() => jest.useRealTimers());

    it('runs at about 60 Hz with the real elapsed time, capped so a stall cannot skip a round', () => {
      jest.useFakeTimers();
      let now = 1_000_000;
      matches.clock = () => now;
      const tick = jest.spyOn(matches, 'tick');
      rooms.start('p1');

      matches.onModuleInit();
      now += 20;
      jest.advanceTimersByTime(20);
      now += 5_000; // the process stalled for 5 s
      jest.advanceTimersByTime(17);
      matches.onModuleDestroy();

      const dts = tick.mock.calls.map((c) => c[0]);
      expect(dts.length).toBeGreaterThanOrEqual(2);
      expect(Math.max(...dts)).toBeLessThanOrEqual(250);
      jest.advanceTimersByTime(1000);
      expect(tick.mock.calls.length).toBe(dts.length); // stopped
    });
  });
});
