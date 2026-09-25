import { DEFAULT_MAP, Match, ROUND_MS, START_MS } from './match-state';
import { loadMap } from './map';
import { Physics } from './physics';
import { Simulation } from './simulation';
import { buildSnapshot, forPlayer } from './snapshot';

const roster = ['p1', 'p2', 'p3', 'p4'].map((id) => ({
  sessionId: id,
  nickname: id.toUpperCase(),
}));

describe('Snapshots', () => {
  const physics = new Physics(loadMap());
  let match: Match;
  let sim: Simulation;

  beforeEach(() => {
    match = new Match({
      roomCode: 'AAAA-AAAA',
      players: roster,
      rounds: 4,
      map: DEFAULT_MAP,
      draw: () => 0,
    });
    match.tick(START_MS);
    sim = new Simulation(physics);
    for (const p of match.view().players) sim.add(p.sessionId, p.position);
    for (let i = 0; i < 90; i++)
      for (const p of roster) sim.step(p.sessionId, true);
  });

  const snapshot = () => buildSnapshot(match.view(), sim);

  it('AC-059: it carries every player with position, facing, animation, life and state @spec:AC-059', () => {
    const snap = snapshot();

    expect(snap.players).toHaveLength(4);
    for (const player of snap.players) {
      expect(Object.keys(player).sort()).toEqual([
        'anim',
        'id',
        'life',
        'status',
        'x',
        'xs',
        'y',
      ]);
      expect(['idle', 'walk', 'jump', 'fall']).toContain(player.anim);
      expect([1, -1]).toContain(player.xs);
      expect(player.life).toBe(6);
      expect(player.status).toBe('active');
    }
  });

  it('AC-059: positions are the simulated ones, not the spawn points @spec:AC-059', () => {
    const before = snapshot().players.find((p) => p.id === 'p1')!;
    sim.enqueue('p1', {
      inputs: Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, r: 1 })),
    });
    for (let i = 0; i < 10; i++) sim.step('p1', true);

    const after = snapshot().players.find((p) => p.id === 'p1')!;

    expect(after.x).toBe(before.x + 40);
    expect(after.xs).toBe(1);
  });

  it('AC-059: facing follows the last walking direction @spec:AC-059', () => {
    sim.enqueue('p2', { inputs: [{ seq: 1, l: 1 }] });
    sim.step('p2', true);

    expect(snapshot().players.find((p) => p.id === 'p2')!.xs).toBe(-1);
  });

  it('AC-059: the animation is walk while walking, jump rising and fall dropping @spec:AC-059', () => {
    sim.enqueue('p1', { inputs: [{ seq: 1, r: 1 }] });
    sim.step('p1', true);
    expect(snapshot().players.find((p) => p.id === 'p1')!.anim).toBe('walk');

    sim.enqueue('p1', { inputs: [{ seq: 2, r: 1, j: 1 }] });
    sim.step('p1', true);
    expect(snapshot().players.find((p) => p.id === 'p1')!.anim).toBe('jump');
  });

  it('AC-059: the state of a player who fell is reported, with their life @spec:AC-059', () => {
    match.playerDown('p3');
    match.tick(16);

    const player = snapshot().players.find((p) => p.id === 'p3')!;

    expect(player.status).toBe('incapacitated');
    expect(player.life).toBe(0);
  });

  it('AC-059: the round clock, phase and score come with it @spec:AC-059', () => {
    match.tick(12_000);

    const snap = snapshot();

    expect(snap.phase).toBe('round');
    expect(snap.timeLeftMs).toBe(ROUND_MS - 12_000);
    expect(snap.score).toEqual({ workers: 0, capatazes: 0 });
    expect(snap.suddenDeath).toBe(false);
    expect(snap.round).toBe(1);
  });

  it('AC-059: machines and bullets are part of it @spec:AC-059', () => {
    const snap = snapshot();

    expect(snap.machines).toHaveLength(7);
    expect(snap.machines.every((m) => m.broken === false)).toBe(true);
    expect(snap.bullets).toEqual([]);
  });

  it('a player with no body yet (a newcomer watching) is shown where the match says, idle', () => {
    match.removePlayer('p4');
    match.addPlayer('late', 'LATE');
    match.tick(16);

    const late = snapshot().players.find((p) => p.id === 'late')!;

    expect(late.status).toBe('spectating');
    expect(late.anim).toBe('idle');
    expect(late.xs).toBe(1);
  });

  it('AC-060: the receiving player gets the number of the last input the server applied for them @spec:AC-060', () => {
    sim.enqueue('p1', { inputs: [{ seq: 1 }, { seq: 2 }, { seq: 3 }] });
    for (let i = 0; i < 3; i++) sim.step('p1', true);
    const snap = snapshot();

    expect(forPlayer(snap, sim, 'p1').ack).toBe(3);
    expect(forPlayer(snap, sim, 'p2').ack).toBe(0);
  });

  it('AC-060: the per-player copy shares the same world @spec:AC-060', () => {
    const snap = snapshot();
    const mine = forPlayer(snap, sim, 'p1');

    expect(mine.players).toEqual(snap.players);
    expect(mine.tick).toBe(snap.tick);
  });

  it('AC-005: a snapshot never carries a session token, only public ids @spec:AC-005 @principle:P-005', () => {
    const json = JSON.stringify(forPlayer(snapshot(), sim, 'p1'));

    expect(json).not.toMatch(/token/i);
    expect(Object.keys(forPlayer(snapshot(), sim, 'p1')).sort()).toEqual(
      [
        'ack',
        'bullets',
        'machines',
        'phase',
        'players',
        'round',
        'score',
        'suddenDeath',
        'tick',
        'timeLeftMs',
      ].sort(),
    );
  });

  it('positions are rounded to two decimals to keep messages small', () => {
    sim.bodyOf('p1')!.x = 100.123456789;
    sim.bodyOf('p1')!.y = 200.987654321;

    const player = snapshot().players.find((p) => p.id === 'p1')!;

    expect(player.x).toBe(100.12);
    expect(player.y).toBe(200.99);
  });
});
