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
import { MatchService } from './match.service';

const player = (id: string): PublicSession => ({
  sessionId: id,
  nickname: id.toUpperCase(),
});

type Seen = {
  code: string;
  event: MatchEvent | { type: 'started'; view: MatchView };
};

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

  const types = () => seen.map((s) => s.event.type);
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
