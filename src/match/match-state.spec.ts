import {
  DEFAULT_MAP,
  INTERMISSION_MS,
  MAX_LIFE,
  Match,
  MatchEvent,
  MatchMap,
  RESULT_MS,
  ROUND_MS,
  START_MS,
} from './match-state';
import { Team } from './match.types';

const map: MatchMap = {
  spawns: {
    workers: [
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
      { x: 40, y: 0 },
    ],
    capatazes: [
      { x: 100, y: 0 },
      { x: 110, y: 0 },
      { x: 120, y: 0 },
      { x: 130, y: 0 },
    ],
  },
  machineIds: ['m1', 'm2', 'm3'],
};

const roster = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    sessionId: `p${i + 1}`,
    nickname: `P${i + 1}`,
  }));

const newMatch = (size = 4, rounds = 4) =>
  new Match({
    roomCode: 'AAAA-AAAA',
    players: roster(size),
    rounds,
    map,
    draw: () => 0,
  });

const team = (match: Match, t: Team) =>
  match.view().players.filter((p) => p.team === t);
const ids = (match: Match, t: Team) => team(match, t).map((p) => p.sessionId);
const types = (events: MatchEvent[]) => events.map((e) => e.type);
const find = <T extends MatchEvent['type']>(events: MatchEvent[], type: T) =>
  events.find((e) => e.type === type) as
    | Extract<MatchEvent, { type: T }>
    | undefined;

// ---- scripted plays --------------------------------------------------------
const begin = (m: Match) => m.tick(START_MS);
const workersWinRound = (m: Match) => {
  map.machineIds.forEach((id) => m.machineBroken(id));
  return m.tick(16);
};
const capatazesWinRound = (m: Match) => m.tick(ROUND_MS);
const nextRound = (m: Match) => m.tick(INTERMISSION_MS);
// plays rounds won by the given teams, in order, and returns every event
const play = (m: Match, winners: Team[]) => {
  const all: MatchEvent[] = [...begin(m)];
  winners.forEach((w, i) => {
    all.push(...(w === 'workers' ? workersWinRound(m) : capatazesWinRound(m)));
    if (i < winners.length - 1) all.push(...nextRound(m));
  });
  return all;
};
const toSuddenDeath = (m: Match) => {
  play(m, ['workers', 'capatazes', 'workers', 'capatazes']);
  return nextRound(m);
};

describe('Match — start and round setup', () => {
  it('AC-034: the match draws half workers and half capatazes @spec:AC-034', () => {
    const m = newMatch(8);

    expect(team(m, 'workers')).toHaveLength(4);
    expect(team(m, 'capatazes')).toHaveLength(4);
  });

  it('a new match counts down before round 1, then starts it', () => {
    const m = newMatch();
    expect(m.view().phase).toBe('starting');

    expect(m.tick(START_MS - 1)).toEqual([]);
    expect(m.view().phase).toBe('starting');
    expect(types(m.tick(1))).toEqual(['round_started']);
    expect(m.view().phase).toBe('round');
  });

  it('AC-036: a round starts with a 60 second clock, everyone at their spawn with full life and every machine intact @spec:AC-036', () => {
    const m = newMatch();

    const events = begin(m);
    const view = m.view();

    expect(find(events, 'round_started')).toEqual({
      type: 'round_started',
      round: 1,
      suddenDeath: false,
    });
    expect(view.timeLeftMs).toBe(60_000);
    expect(view.timeLeftMs).toBe(ROUND_MS);
    for (const t of ['workers', 'capatazes'] as Team[]) {
      team(m, t).forEach((p, i) => {
        expect(p.position).toEqual(map.spawns[t][i]);
        expect(p.life).toBe(MAX_LIFE);
        expect(p.status).toBe('active');
      });
    }
    expect(view.machines).toEqual([
      { id: 'm1', broken: false },
      { id: 'm2', broken: false },
      { id: 'm3', broken: false },
    ]);
  });

  it('AC-036: the next round starts fresh again, whatever happened in the last one @spec:AC-036', () => {
    const m = newMatch();
    begin(m);
    m.machineBroken('m1');
    m.playerDown(ids(m, 'workers')[0]);
    m.tick(ROUND_MS); // capatazes hold out
    m.tick(INTERMISSION_MS - 1);
    // meanwhile the intermission must not let anything change the state
    expect(m.view().phase).toBe('intermission');

    const events = m.tick(1);
    const view = m.view();

    expect(find(events, 'round_started')).toEqual({
      type: 'round_started',
      round: 2,
      suddenDeath: false,
    });
    expect(view.timeLeftMs).toBe(ROUND_MS);
    expect(
      view.players.every((p) => p.status === 'active' && p.life === MAX_LIFE),
    ).toBe(true);
    expect(view.machines.every((mc) => !mc.broken)).toBe(true);
    team(m, 'workers').forEach((p, i) =>
      expect(p.position).toEqual(map.spawns.workers[i]),
    );
  });

  it('the timings are the ones in the spec: 60 s rounds, 5 s breaks, 10 s result @spec:AC-036 @spec:AC-040 @spec:AC-045', () => {
    expect(ROUND_MS).toBe(60_000);
    expect(INTERMISSION_MS).toBe(5_000);
    expect(RESULT_MS).toBe(10_000);
    expect(MAX_LIFE).toBe(6);
  });

  it('the default map is the exported room: spawns for a full team and its 7 machines', () => {
    expect(DEFAULT_MAP.spawns.workers.length).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_MAP.spawns.capatazes.length).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_MAP.machineIds).toHaveLength(7);
  });

  it('AC-005: the match view never carries a session token, only public fields @spec:AC-005 @principle:P-005', () => {
    const view = newMatch().view();

    expect(Object.keys(view).sort()).toEqual(
      [
        'machines',
        'phase',
        'players',
        'result',
        'roomCode',
        'round',
        'roundLimit',
        'roundsPlayed',
        'score',
        'suddenDeath',
        'timeLeftMs',
      ].sort(),
    );
    for (const player of view.players) {
      expect(Object.keys(player).sort()).toEqual(
        [
          'life',
          'look',
          'nickname',
          'position',
          'role',
          'sessionId',
          'status',
          'team',
        ].sort(),
      );
    }
  });
});

describe('Match — how a round is won', () => {
  it('AC-037: breaking the last machine ends the round at once and scores for the workers @spec:AC-037', () => {
    const m = newMatch();
    begin(m);
    m.tick(10_000);
    m.machineBroken('m1');
    m.machineBroken('m2');
    expect(m.tick(16)).toEqual([]); // one machine still standing

    m.machineBroken('m3');
    const events = m.tick(16);

    expect(find(events, 'round_ended')).toEqual({
      type: 'round_ended',
      winner: 'workers',
      reason: 'machines',
      score: { workers: 1, capatazes: 0 },
      roundsPlayed: 1,
    });
    expect(m.view().phase).toBe('intermission');
  });

  it('AC-037: breaking an unknown or already broken machine changes nothing @spec:AC-037', () => {
    const m = newMatch();
    begin(m);

    m.machineBroken('nope');
    m.machineBroken('m1');
    m.machineBroken('m1');
    m.tick(16);

    expect(m.view().machines.filter((mc) => mc.broken)).toHaveLength(1);
  });

  it('AC-038: with a machine standing, the clock hitting zero scores for the capatazes @spec:AC-038', () => {
    const m = newMatch();
    begin(m);
    m.machineBroken('m1');
    m.machineBroken('m2');
    expect(m.tick(ROUND_MS - 1)).toEqual([]);

    const events = m.tick(1);

    expect(find(events, 'round_ended')).toEqual({
      type: 'round_ended',
      winner: 'capatazes',
      reason: 'clock',
      score: { workers: 0, capatazes: 1 },
      roundsPlayed: 1,
    });
  });

  it('the round clock counts down while the round is open', () => {
    const m = newMatch();
    begin(m);

    m.tick(12_500);

    expect(m.view().timeLeftMs).toBe(ROUND_MS - 12_500);
  });

  it('AC-039: every worker incapacitated ends the round for the capatazes before the clock @spec:AC-039', () => {
    const m = newMatch(8);
    begin(m);
    m.tick(5_000);
    const workers = ids(m, 'workers');
    workers.slice(0, 3).forEach((id) => m.playerDown(id));
    expect(m.tick(16)).toEqual([]); // one worker still on his feet

    m.playerDown(workers[3]);
    const events = m.tick(16);

    expect(find(events, 'round_ended')).toMatchObject({
      winner: 'capatazes',
      reason: 'workers_down',
    });
    expect(
      m.view().players.filter((p) => p.status === 'incapacitated'),
    ).toHaveLength(4);
  });

  it('AC-039: capatazes going down does not end the round by itself @spec:AC-039', () => {
    const m = newMatch();
    begin(m);
    ids(m, 'capatazes').forEach((id) => m.playerDown(id));

    expect(m.tick(16)).toEqual([]);
    expect(m.view().phase).toBe('round');
  });

  it('a player going down is incapacitated (not eliminated) in a normal round', () => {
    const m = newMatch();
    begin(m);
    const victim = ids(m, 'capatazes')[0];

    m.playerDown(victim);
    m.tick(16);

    const player = m.view().players.find((p) => p.sessionId === victim)!;
    expect(player.status).toBe('incapacitated');
    expect(player.life).toBe(0);
  });

  it('breaking machines or going down when no round is open changes nothing', () => {
    const m = newMatch();
    m.machineBroken('m1'); // countdown
    m.playerDown('p1');
    begin(m);
    expect(m.view().machines.every((mc) => !mc.broken)).toBe(true);
    expect(m.view().players.every((p) => p.status === 'active')).toBe(true);

    capatazesWinRound(m); // intermission now
    m.machineBroken('m1');
    m.playerDown('p1');
    m.tick(16);

    expect(m.view().machines.every((mc) => !mc.broken)).toBe(true);
    expect(m.view().players.every((p) => p.status === 'active')).toBe(true);
  });
});

describe('Match — rounds and the 2-point lead', () => {
  it('AC-040: after a round everyone sees the winner and score for 5 seconds before the next one @spec:AC-040', () => {
    const m = newMatch();
    begin(m);

    const events = workersWinRound(m);
    const ended = find(events, 'round_ended')!;

    expect(ended.winner).toBe('workers');
    expect(ended.score).toEqual({ workers: 1, capatazes: 0 });
    expect(m.view().phase).toBe('intermission');
    expect(m.view().timeLeftMs).toBe(INTERMISSION_MS);
    expect(m.tick(INTERMISSION_MS - 1)).toEqual([]);
    expect(m.view().phase).toBe('intermission');
    expect(types(m.tick(1))).toEqual(['round_started']);
    expect(m.view().phase).toBe('round');
    expect(m.view().round).toBe(2);
  });

  it('AC-041: a 2-0 lead ends the match, workers win @spec:AC-041', () => {
    const m = newMatch();

    const events = play(m, ['workers', 'workers']);

    expect(find(events, 'match_ended')).toEqual({
      type: 'match_ended',
      winner: 'workers',
      reason: 'score',
      score: { workers: 2, capatazes: 0 },
    });
    expect(m.view().phase).toBe('finished');
  });

  it('AC-041: a 0-2 lead ends the match, capatazes win @spec:AC-041', () => {
    const m = newMatch();

    const events = play(m, ['capatazes', 'capatazes']);

    expect(find(events, 'match_ended')).toMatchObject({
      winner: 'capatazes',
      reason: 'score',
    });
  });

  it('AC-041: a 3-1 lead after four rounds wins the match instead of sudden death @spec:AC-041', () => {
    const m = newMatch(4, 4);

    const events = play(m, ['workers', 'capatazes', 'workers', 'workers']);

    expect(find(events, 'match_ended')).toMatchObject({
      winner: 'workers',
      score: { workers: 3, capatazes: 1 },
    });
    expect(types(events)).not.toContain('sudden_death');
  });

  it('AC-041: with a 1-0 lead the match goes on @spec:AC-041', () => {
    const m = newMatch();

    const events = play(m, ['workers']);

    expect(types(events)).not.toContain('match_ended');
    expect(m.view().phase).toBe('intermission');
  });

  it('AC-042: 2-2 after four rounds goes to sudden death and everyone is told @spec:AC-042', () => {
    const m = newMatch(4, 4);

    const events = play(m, ['workers', 'capatazes', 'workers', 'capatazes']);

    expect(types(events).slice(-2)).toEqual(['round_ended', 'sudden_death']);
    expect(m.view().phase).toBe('intermission');
    expect(m.view().suddenDeath).toBe(false); // announced, starts after the break
  });

  it('AC-042: the round limit is the room setting: with 6, 2-2 after four rounds plays round 5 @spec:AC-042', () => {
    const m = newMatch(4, 6);

    const events = play(m, ['workers', 'capatazes', 'workers', 'capatazes']);
    const next = nextRound(m);

    expect(types(events)).not.toContain('sudden_death');
    expect(find(next, 'round_started')).toEqual({
      type: 'round_started',
      round: 5,
      suddenDeath: false,
    });
  });

  it('AC-042: with limit 6 sudden death comes after round six @spec:AC-042', () => {
    const m = newMatch(4, 6);

    const events = play(m, [
      'workers',
      'capatazes',
      'workers',
      'capatazes',
      'workers',
      'capatazes',
    ]);

    expect(types(events)).toContain('sudden_death');
  });
});

describe('Match — sudden death', () => {
  it('AC-044: sudden death starts after the break with no clock @spec:AC-044', () => {
    const m = newMatch();

    const events = toSuddenDeath(m);

    expect(find(events, 'round_started')).toEqual({
      type: 'round_started',
      round: null,
      suddenDeath: true,
    });
    expect(m.view().phase).toBe('sudden_death');
    expect(m.view().suddenDeath).toBe(true);
    expect(m.view().timeLeftMs).toBeNull();
    m.tick(10 * 60_000);
    expect(m.view().phase).toBe('sudden_death');
  });

  it('AC-044: hitting machines has no effect in sudden death @spec:AC-044', () => {
    const m = newMatch();
    toSuddenDeath(m);

    map.machineIds.forEach((id) => m.machineBroken(id));
    const events = m.tick(16);

    expect(events).toEqual([]);
    expect(m.view().phase).toBe('sudden_death');
    expect(m.view().machines.every((mc) => !mc.broken)).toBe(true);
  });

  it('AC-044: everyone starts sudden death with full life at their spawn @spec:AC-044', () => {
    const sd = newMatch();
    play(sd, ['workers', 'capatazes', 'workers']); // 2-1, break before round 4
    nextRound(sd);
    sd.playerDown('p1'); // p1 falls in round 4
    sd.tick(16);
    expect(sd.view().players.find((p) => p.sessionId === 'p1')!.status).toBe(
      'incapacitated',
    );
    sd.tick(ROUND_MS); // capatazes hold out: 2-2, sudden death is announced
    nextRound(sd);

    expect(sd.view().phase).toBe('sudden_death');
    expect(
      sd
        .view()
        .players.every((p) => p.status === 'active' && p.life === MAX_LIFE),
    ).toBe(true);
    team(sd, 'capatazes').forEach((p, i) =>
      expect(p.position).toEqual(map.spawns.capatazes[i]),
    );
  });

  it('AC-043: a player who goes down in sudden death is eliminated and never comes back @spec:AC-043', () => {
    const m = newMatch(8);
    toSuddenDeath(m);
    const victim = ids(m, 'workers')[0];

    m.playerDown(victim);
    m.tick(16);
    m.tick(5 * 60_000);

    expect(m.view().players.find((p) => p.sessionId === victim)!.status).toBe(
      'eliminated',
    );
    expect(m.view().phase).toBe('sudden_death');
  });

  it('AC-043: when every worker is eliminated the capatazes win the match @spec:AC-043', () => {
    const m = newMatch();
    toSuddenDeath(m);
    ids(m, 'workers').forEach((id) => m.playerDown(id));

    const events = m.tick(16);

    expect(find(events, 'match_ended')).toMatchObject({
      winner: 'capatazes',
      reason: 'sudden_death',
    });
    expect(m.view().phase).toBe('finished');
  });

  it('AC-043: when every capataz is eliminated the workers win the match @spec:AC-043', () => {
    const m = newMatch();
    toSuddenDeath(m);
    ids(m, 'capatazes').forEach((id) => m.playerDown(id));

    expect(find(m.tick(16), 'match_ended')).toMatchObject({
      winner: 'workers',
      reason: 'sudden_death',
    });
  });

  it('AC-043: one player left standing on each side keeps the fight going @spec:AC-043', () => {
    const m = newMatch(8);
    toSuddenDeath(m);
    ids(m, 'workers')
      .slice(0, 3)
      .forEach((id) => m.playerDown(id));
    ids(m, 'capatazes')
      .slice(0, 3)
      .forEach((id) => m.playerDown(id));

    expect(m.tick(16)).toEqual([]);
    expect(m.view().phase).toBe('sudden_death');
  });

  it('AC-066: both teams wiped in the same tick is a tie and sudden death restarts with everyone back @spec:AC-066', () => {
    const m = newMatch(8);
    toSuddenDeath(m);
    // one worker fell earlier, the rest of both teams fall together
    const workers = ids(m, 'workers');
    m.playerDown(workers[0]);
    m.tick(16);
    workers.slice(1).forEach((id) => m.playerDown(id));
    ids(m, 'capatazes').forEach((id) => m.playerDown(id));

    const events = m.tick(16);

    expect(types(events)).toEqual(['sudden_death_tie', 'round_started']);
    expect(find(events, 'round_started')).toEqual({
      type: 'round_started',
      round: null,
      suddenDeath: true,
    });
    expect(m.view().phase).toBe('sudden_death');
    expect(
      m
        .view()
        .players.every((p) => p.status === 'active' && p.life === MAX_LIFE),
    ).toBe(true);
    team(m, 'workers').forEach((p, i) =>
      expect(p.position).toEqual(map.spawns.workers[i]),
    );
  });

  it('AC-066: the last worker and the last capataz falling in the same tick is a tie, not a win for whoever was processed first @spec:AC-066', () => {
    const m = newMatch();
    toSuddenDeath(m);
    ids(m, 'workers').forEach((id) => m.playerDown(id));
    ids(m, 'capatazes').forEach((id) => m.playerDown(id));

    expect(types(m.tick(16))).toContain('sudden_death_tie');
    expect(m.view().phase).toBe('sudden_death');
  });

  it('AC-066: falling in different ticks is not a tie @spec:AC-066', () => {
    const m = newMatch();
    toSuddenDeath(m);
    ids(m, 'workers').forEach((id) => m.playerDown(id));
    const first = m.tick(16);
    ids(m, 'capatazes').forEach((id) => m.playerDown(id));
    const second = m.tick(16);

    expect(types(first)).toContain('match_ended');
    expect(second).toEqual([]);
    expect(m.view().result).toMatchObject({ winner: 'capatazes' });
  });
});

describe('Match — the end', () => {
  it('AC-045: everyone sees the winner and the final score, and 10 seconds later the match closes @spec:AC-045', () => {
    const m = newMatch();

    const events = play(m, ['workers', 'workers']);
    const ended = find(events, 'match_ended')!;

    expect(ended.winner).toBe('workers');
    expect(ended.score).toEqual({ workers: 2, capatazes: 0 });
    expect(m.view().result).toEqual({ winner: 'workers', reason: 'score' });
    expect(m.tick(RESULT_MS - 1)).toEqual([]);
    expect(m.tick(1)).toEqual([{ type: 'closed' }]);
    expect(m.tick(60_000)).toEqual([]); // only once
  });

  it('nothing changes the outcome once the match is finished', () => {
    const m = newMatch();
    play(m, ['workers', 'workers']);

    m.machineBroken('m1');
    m.playerDown('p1');
    m.tick(30_000);

    expect(m.view().score).toEqual({ workers: 2, capatazes: 0 });
    expect(m.view().phase).toBe('finished');
  });
});

describe('Match — players who leave and players who take their seat', () => {
  it('AC-046: when every worker has left the capatazes win by walkover @spec:AC-046', () => {
    const m = newMatch(4);
    begin(m);
    const workers = ids(m, 'workers');

    m.removePlayer(workers[0]);
    expect(m.tick(16)).not.toContainEqual(
      expect.objectContaining({ type: 'match_ended' }),
    );
    m.removePlayer(workers[1]);
    const events = m.tick(16);

    expect(find(events, 'match_ended')).toEqual({
      type: 'match_ended',
      winner: 'capatazes',
      reason: 'walkover',
      score: { workers: 0, capatazes: 0 },
    });
    expect(m.view().phase).toBe('finished');
  });

  it('AC-046: when every capataz has left the workers win by walkover, in any phase @spec:AC-046', () => {
    const m = newMatch(4);
    play(m, ['workers']); // intermission
    ids(m, 'capatazes').forEach((id) => m.removePlayer(id));

    expect(find(m.tick(16), 'match_ended')).toMatchObject({
      winner: 'workers',
      reason: 'walkover',
    });
  });

  it('AC-046: a team with one player left plays on @spec:AC-046', () => {
    const m = newMatch(4);
    begin(m);
    m.removePlayer(ids(m, 'workers')[0]);

    m.tick(16);

    expect(m.view().phase).toBe('round');
    expect(ids(m, 'workers')).toHaveLength(1);
  });

  it('AC-046: a walkover ends the match at once, sudden death included @spec:AC-046', () => {
    const m = newMatch(4);
    toSuddenDeath(m);
    ids(m, 'workers').forEach((id) => m.removePlayer(id));

    expect(find(m.tick(16), 'match_ended')).toMatchObject({
      winner: 'capatazes',
      reason: 'walkover',
    });
  });

  it('the last worker leaving while the others are down also hands the round over correctly', () => {
    const m = newMatch(8);
    begin(m);
    const workers = ids(m, 'workers');
    workers.slice(0, 3).forEach((id) => m.playerDown(id));
    m.removePlayer(workers[3]);

    const events = m.tick(16);

    // three workers are down, none active: the round goes to the capatazes
    expect(find(events, 'round_ended')).toMatchObject({
      winner: 'capatazes',
      reason: 'workers_down',
    });
  });

  it('AC-072: a newcomer takes the open seat with the same team, role and look @spec:AC-072', () => {
    const m = newMatch(4);
    begin(m);
    const leaver = m.view().players.find((p) => p.role === 'owner')!;
    m.removePlayer(leaver.sessionId);

    const accepted = m.addPlayer('newbie', 'NEWBIE');
    const events = m.tick(16);

    expect(accepted).toBe(true);
    const joined = find(events, 'player_joined')!;
    expect(joined.player).toMatchObject({
      sessionId: 'newbie',
      nickname: 'NEWBIE',
      team: 'capatazes',
      role: 'owner',
      look: null,
    });
    expect(types(events)).toContain('player_left');
  });

  it('AC-072: a newcomer takes a worker seat keeping the look of the worker who left @spec:AC-072', () => {
    const m = newMatch(4);
    begin(m);
    const leaver = m
      .view()
      .players.find((p) => p.team === 'workers' && p.look === 'op2')!;
    m.removePlayer(leaver.sessionId);

    m.addPlayer('newbie', 'NEWBIE');

    expect(
      m.view().players.find((p) => p.sessionId === 'newbie'),
    ).toMatchObject({
      team: 'workers',
      role: 'worker',
      look: 'op2',
    });
  });

  it('AC-072: the newcomer watches until the next round, then enters with full life @spec:AC-072', () => {
    const m = newMatch(4);
    begin(m);
    m.removePlayer(ids(m, 'capatazes')[1]);
    m.addPlayer('newbie', 'NEWBIE');
    m.tick(16);

    expect(m.view().players.find((p) => p.sessionId === 'newbie')!.status).toBe(
      'spectating',
    );
    capatazesWinRound(m);
    expect(m.view().players.find((p) => p.sessionId === 'newbie')!.status).toBe(
      'spectating',
    );
    nextRound(m);

    const newbie = m.view().players.find((p) => p.sessionId === 'newbie')!;
    expect(newbie.status).toBe('active');
    expect(newbie.life).toBe(MAX_LIFE);
    expect(newbie.position).toEqual(
      map.spawns.capatazes[ids(m, 'capatazes').indexOf('newbie')],
    );
  });

  it('AC-072: a newcomer cannot change the current round while they watch @spec:AC-072', () => {
    const m = newMatch(4);
    begin(m);
    m.removePlayer(ids(m, 'workers')[0]);
    m.addPlayer('newbie', 'NEWBIE');

    m.playerDown('newbie');
    m.tick(16);

    expect(m.view().players.find((p) => p.sessionId === 'newbie')!.status).toBe(
      'spectating',
    );
  });

  it('AC-072: a team made only of newcomers is not a walkover @spec:AC-072', () => {
    const m = newMatch(4);
    begin(m);
    ids(m, 'workers').forEach((id) => m.removePlayer(id));
    m.addPlayer('n1', 'N1');
    m.addPlayer('n2', 'N2');

    expect(types(m.tick(16))).not.toContain('match_ended');
  });

  it('AC-072: with no seat open there is nothing to take @spec:AC-072', () => {
    const m = newMatch(4);
    begin(m);

    expect(m.addPlayer('newbie', 'NEWBIE')).toBe(false);
    expect(m.view().players).toHaveLength(4);
  });

  it('AC-072: seats are filled in the order they were vacated @spec:AC-072', () => {
    const m = newMatch(8);
    begin(m);
    const first = m.view().players.find((p) => p.role === 'owner')!;
    const second = m.view().players.find((p) => p.team === 'workers')!;
    m.removePlayer(first.sessionId);
    m.removePlayer(second.sessionId);

    m.addPlayer('a', 'A');
    m.addPlayer('b', 'B');

    expect(m.view().players.find((p) => p.sessionId === 'a')!.role).toBe(
      'owner',
    );
    expect(m.view().players.find((p) => p.sessionId === 'b')!.team).toBe(
      'workers',
    );
  });

  it('AC-072: in sudden death a newcomer waits for the next sudden death round and does not count as standing @spec:AC-072', () => {
    const m = newMatch(4);
    toSuddenDeath(m);
    const [w1, w2] = ids(m, 'workers');
    m.removePlayer(w1);
    m.addPlayer('newbie', 'NEWBIE');
    m.playerDown(w2);

    const events = m.tick(16);

    expect(find(events, 'match_ended')).toMatchObject({
      winner: 'capatazes',
      reason: 'sudden_death',
    });
  });

  it('nobody can take a seat after the match is over', () => {
    const m = newMatch(4);
    play(m, ['workers', 'workers']);
    m.removePlayer('p1');

    expect(m.addPlayer('newbie', 'NEWBIE')).toBe(false);
  });
});

describe('Match — life, being downed and being revived', () => {
  const lifeOf = (m: Match, id: string) =>
    m.view().players.find((p) => p.sessionId === id)!;

  it('AC-052: damage takes life away in half-hearts and never below zero @spec:AC-052', () => {
    const m = newMatch();
    begin(m);
    const victim = ids(m, 'workers')[0];

    m.damage(victim, 1);
    expect(lifeOf(m, victim).life).toBe(5);
    m.damage(victim, 2);
    expect(lifeOf(m, victim).life).toBe(3);
    expect(lifeOf(m, victim).status).toBe('active');

    m.damage(victim, 99);
    expect(lifeOf(m, victim).life).toBe(0);
  });

  it('AC-052: when life reaches zero in a normal round the player is incapacitated, not eliminated @spec:AC-052', () => {
    const m = newMatch();
    begin(m);
    const victim = ids(m, 'workers')[0];

    m.damage(victim, MAX_LIFE);

    expect(lifeOf(m, victim).status).toBe('incapacitated');
    expect(m.motionOf(victim)).toBe('fall');
    expect(m.canMove(victim)).toBe(false);
  });

  it('AC-043: when life reaches zero in sudden death the player is eliminated for good @spec:AC-043', () => {
    const m = newMatch();
    toSuddenDeath(m);
    const victim = ids(m, 'workers')[0];

    m.damage(victim, MAX_LIFE);

    expect(lifeOf(m, victim).status).toBe('eliminated');
    expect(m.motionOf(victim)).toBe('fall');
  });

  it('AC-052: damage to someone who is already down, watching or outside a round does nothing @spec:AC-052', () => {
    const m = newMatch();
    m.damage('p1', 3); // countdown
    expect(lifeOf(m, 'p1').life).toBe(MAX_LIFE);

    begin(m);
    m.damage('p1', MAX_LIFE);
    m.damage('p1', 1); // already down
    expect(lifeOf(m, 'p1').life).toBe(0);

    m.tick(ROUND_MS); // break
    m.damage('p2', 3);
    expect(lifeOf(m, 'p2').life).toBe(MAX_LIFE);
  });

  it('AC-052: damage of zero or less, or to nobody, changes nothing @spec:AC-052', () => {
    const m = newMatch();
    begin(m);

    m.damage('p1', 0);
    m.damage('p1', -3);
    m.damage('nobody', 3);

    expect(m.view().players.every((p) => p.life === MAX_LIFE)).toBe(true);
  });

  it('AC-052: the round is decided at the next tick, so two falls in the same tick are seen together @spec:AC-052', () => {
    const m = newMatch();
    toSuddenDeath(m);
    ids(m, 'workers').forEach((id) => m.damage(id, MAX_LIFE));
    ids(m, 'capatazes').forEach((id) => m.damage(id, MAX_LIFE));

    expect(types(m.tick(16))).toContain('sudden_death_tie');
  });

  it('AC-069: reviving an incapacitated player puts them back on their feet with 1 heart (2 half-hearts) @spec:AC-069', () => {
    const m = newMatch();
    begin(m);
    const victim = ids(m, 'capatazes')[1];
    m.damage(victim, MAX_LIFE);

    expect(m.revive(victim)).toBe(true);

    expect(lifeOf(m, victim)).toMatchObject({ status: 'active', life: 2 });
    expect(m.canMove(victim)).toBe(true);
  });

  it('AC-069: a revived player counts as standing again, so the round is not lost for their team @spec:AC-069', () => {
    const m = newMatch(8);
    begin(m);
    const workers = ids(m, 'workers');
    workers.forEach((id) => m.damage(id, MAX_LIFE));
    m.revive(workers[0]);

    expect(m.tick(16)).toEqual([]);
    expect(m.view().phase).toBe('round');
  });

  it('AC-071: nobody is revived in sudden death @spec:AC-071', () => {
    const m = newMatch(8);
    toSuddenDeath(m);
    const victim = ids(m, 'workers')[0];
    m.damage(victim, MAX_LIFE);

    expect(m.revive(victim)).toBe(false);
    expect(lifeOf(m, victim).status).toBe('eliminated');
  });

  it('AC-069: only an incapacitated player can be revived @spec:AC-069', () => {
    const m = newMatch();
    begin(m);

    expect(m.revive('p1')).toBe(false); // on their feet
    expect(m.revive('nobody')).toBe(false);
    m.damage('p1', 1);
    expect(m.revive('p1')).toBe(false);
    expect(lifeOf(m, 'p1').life).toBe(5);
  });

  it('AC-053: a player who was downed is back on their feet with full life next round @spec:AC-053', () => {
    const m = newMatch(8);
    begin(m);
    const victim = ids(m, 'capatazes')[0];
    m.damage(victim, MAX_LIFE);
    m.tick(ROUND_MS);

    m.tick(INTERMISSION_MS);

    expect(lifeOf(m, victim)).toMatchObject({
      status: 'active',
      life: MAX_LIFE,
    });
  });

  it('motion: move while on their feet in a round, fall when down, frozen otherwise', () => {
    const m = newMatch(8);
    expect(m.motionOf('p1')).toBe('frozen'); // countdown

    begin(m);
    const [a, b] = ids(m, 'workers');
    m.damage(b, MAX_LIFE);
    expect(m.motionOf(a)).toBe('move');
    expect(m.motionOf(b)).toBe('fall');

    m.removePlayer(ids(m, 'capatazes')[0]);
    m.addPlayer('late', 'LATE');
    m.tick(16);
    expect(m.motionOf('late')).toBe('frozen'); // watching until the next round

    m.tick(ROUND_MS);
    expect(m.motionOf(a)).toBe('frozen'); // break
    expect(m.motionOf('nobody')).toBe('frozen');
  });

  it('exposes the roster without copying it, for the game loop', () => {
    const m = newMatch();

    expect(
      m
        .roster()
        .map((p) => p.sessionId)
        .sort(),
    ).toEqual(['p1', 'p2', 'p3', 'p4']);
  });
});
