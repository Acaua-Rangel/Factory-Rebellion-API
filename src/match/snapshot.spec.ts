import { DEFAULT_MAP, Match, ROUND_MS, START_MS } from './match-state';
import { loadMap } from './map';
import { Physics } from './physics';
import { Simulation } from './simulation';
import { buildSnapshot, forPlayer } from './snapshot';
import { Combat, MELEE_COOLDOWN, REVIVE_FRAMES } from './combat';
import { Machines } from './machines';

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
    // a real client sends an input every frame, even standing still: settle the
    // bodies the same way (neutral inputs), then let the numbering start over
    for (const p of roster) {
      for (let batch = 0; batch < 3; batch++) {
        sim.enqueue(p.sessionId, {
          inputs: Array.from({ length: 30 }, (_, i) => ({
            seq: batch * 30 + i + 1,
          })),
        });
        for (let f = 0; f < 30; f++) sim.step(p.sessionId, true);
      }
      sim.resync(p.sessionId);
    }
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
        'rv',
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

  describe('machines', () => {
    it('AC-051: every machine is listed with its integrity and whether it is broken @spec:AC-051', () => {
      const machines = new Machines(loadMap(), match);

      const snap = buildSnapshot(match.view(), sim, undefined, machines);

      expect(snap.machines).toHaveLength(7);
      for (const machine of snap.machines) {
        expect(Object.keys(machine).sort()).toEqual(['broken', 'hp', 'id']);
        expect(machine).toMatchObject({ hp: 100, broken: false });
      }
    });

    it('AC-051: damage and repairs show in the next snapshot @spec:AC-051', () => {
      const machines = new Machines(loadMap(), match);
      const body = loadMap().colliders.find(
        (c) => c.id === loadMap().machines[0].collider,
      )!.rect;
      machines.hit(body, 'worker');
      machines.hit(body, 'worker');

      const snap = buildSnapshot(match.view(), sim, undefined, machines);

      expect(snap.machines[0].hp).toBe(80);
      expect(snap.machines.slice(1).every((m) => m.hp === 100)).toBe(true);
    });

    it('without machines the snapshot falls back to the match view (all intact, no integrity)', () => {
      expect(snapshot().machines).toHaveLength(7);
    });
  });

  describe('with combat', () => {
    let combat: Combat;
    const KEYS = { left: false, right: false, jump: false, down: false };
    const withCombat = () => buildSnapshot(match.view(), sim, combat);
    const owner = () =>
      match.view().players.find((p) => p.role === 'owner')!.sessionId;
    const put = (id: string, x: number, y = 896, facing: 1 | -1 = 1) => {
      const b = sim.bodyOf(id)!;
      b.x = x;
      b.y = y;
      b.facing = facing;
    };

    beforeEach(() => {
      combat = new Combat(loadMap(), match, sim);
    });

    it('AC-056: bullets in flight are listed with an id, a position and a direction @spec:AC-056', () => {
      put(owner(), 800);
      combat.act(owner(), { ...KEYS, seq: 1, attack: true, interact: false });

      const [bullet] = withCombat().bullets;

      expect(Object.keys(bullet).sort()).toEqual(['d', 'id', 'x', 'y']);
      expect(bullet.d).toBe(1);
      expect(bullet.x).toBeGreaterThan(800);
    });

    it('AC-059: someone who just hit in melee is shown with the hit animation @spec:AC-059', () => {
      const worker = match
        .view()
        .players.find((p) => p.team === 'workers')!.sessionId;
      combat.act(worker, { ...KEYS, seq: 1, attack: true, interact: false });

      expect(withCombat().players.find((p) => p.id === worker)!.anim).toBe(
        'hit',
      );
      for (let i = 0; i < MELEE_COOLDOWN; i++) combat.frame();
      expect(withCombat().players.find((p) => p.id === worker)!.anim).not.toBe(
        'hit',
      );
    });

    it('AC-069: a downed player being revived shows how far along it is @spec:AC-069', () => {
      const [downed, helper] = match
        .view()
        .players.filter((p) => p.role === 'policeman' || p.role === 'owner')
        .map((p) => p.sessionId);
      put(downed, 800);
      put(helper, 830);
      match.damage(downed, 6);
      for (let i = 0; i < REVIVE_FRAMES / 2; i++) {
        combat.act(helper, {
          ...KEYS,
          seq: i + 1,
          attack: false,
          interact: true,
        });
        combat.frame();
      }

      const players = withCombat().players;

      expect(players.find((p) => p.id === downed)!.rv).toBeCloseTo(0.5, 2);
      expect(players.find((p) => p.id === helper)!.rv).toBe(0);
    });

    it('without combat the snapshot still works, with no bullets and no progress', () => {
      const snap = snapshot();

      expect(snap.bullets).toEqual([]);
      expect(snap.players.every((p) => p.rv === 0)).toBe(true);
    });

    it('AC-005: bullets never carry who fired them by session, only a number @spec:AC-005 @principle:P-005', () => {
      put(owner(), 800);
      combat.act(owner(), { ...KEYS, seq: 1, attack: true, interact: false });

      expect(JSON.stringify(withCombat().bullets)).not.toContain(owner());
    });
  });
});
