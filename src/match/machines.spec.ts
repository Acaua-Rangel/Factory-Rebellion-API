import { loadMap, Rect } from './map';
import {
  MACHINE_HP,
  MELEE_MACHINE_DAMAGE,
  Machines,
  REPAIR_PER_SECOND,
} from './machines';
import {
  DEFAULT_MAP,
  INTERMISSION_MS,
  Match,
  ROUND_MS,
  START_MS,
} from './match-state';
import { Role, Team } from './match.types';

const map = loadMap();
const roster = Array.from({ length: 8 }, (_, i) => ({ sessionId: `p${i + 1}`, nickname: `P${i + 1}` }));

const rectOf = (machineId: string): Rect => {
  const machine = map.machines.find((m) => m.id === machineId)!;
  return map.colliders.find((c) => c.id === machine.collider)!.rect;
};
const FAR: Rect = { left: 2000, right: 2040, top: 0, bottom: 40 }; // near no machine
const EVERYTHING: Rect = { left: -100, right: 2200, top: -100, bottom: 1200 };
// the lower machine 1 (x=812, y=796) and its body
const M = 'machine7';

describe('Machines', () => {
  let match: Match;
  let machines: Machines;
  let broken: string[];

  beforeEach(() => {
    match = new Match({ roomCode: 'AAAA-AAAA', players: roster, rounds: 4, map: DEFAULT_MAP, draw: () => 0 });
    match.tick(START_MS);
    machines = new Machines(map, match);
    broken = [];
    machines.onBroken((id) => broken.push(id));
  });

  const hp = (id = M) => machines.integrityOf(id);
  const hit = (rect: Rect = rectOf(M), role: Role = 'worker') => machines.hit(rect, role);
  const repairFrames = (n: number, rect: Rect = rectOf(M), role: Role = 'owner') => {
    for (let i = 0; i < n; i++) machines.repair(rect, role);
  };
  const toSuddenDeath = () => {
    const win = (w: Team) => {
      if (w === 'workers') {
        DEFAULT_MAP.machineIds.forEach((id) => match.machineBroken(id));
        match.tick(16);
      } else {
        match.tick(ROUND_MS);
      }
      match.tick(INTERMISSION_MS);
    };
    (['workers', 'capatazes', 'workers', 'capatazes'] as Team[]).forEach(win);
    expect(match.view().phase).toBe('sudden_death');
  };

  it('the numbers are the ones of the spec: 100 integrity, 10 per hit, 5 repaired per second @spec:AC-047 @spec:AC-067', () => {
    expect(MACHINE_HP).toBe(100);
    expect(MELEE_MACHINE_DAMAGE).toBe(10);
    expect(REPAIR_PER_SECOND).toBe(5);
  });

  describe('breaking a machine', () => {
    it('AC-051: every machine of the room starts intact with 100 integrity @spec:AC-051', () => {
      const list = machines.list();

      expect(list).toHaveLength(7);
      expect(list.every((m) => m.hp === 100 && m.broken === false)).toBe(true);
      expect(list.map((m) => m.id)).toEqual(DEFAULT_MAP.machineIds);
    });

    it('AC-047: each hit by an Operário wears the machine down by 10 @spec:AC-047', () => {
      hit();
      expect(hp()).toBe(90);
      hit();
      expect(hp()).toBe(80);
      expect(broken).toEqual([]);
    });

    it('AC-047: after ten hits the machine is broken and everybody is told which one @spec:AC-047', () => {
      for (let i = 0; i < 9; i++) expect(hit()).toEqual([]);

      expect(hit()).toEqual([M]);

      expect(hp()).toBe(0);
      expect(machines.list().find((m) => m.id === M)!.broken).toBe(true);
      expect(broken).toEqual([M]);
    });

    it('AC-047: hitting a machine that is already broken changes nothing and announces nothing @spec:AC-047', () => {
      for (let i = 0; i < 10; i++) hit();

      expect(hit()).toEqual([]);

      expect(hp()).toBe(0);
      expect(broken).toEqual([M]);
    });

    it('AC-047: a hit reaches every machine whose body it overlaps @spec:AC-047', () => {
      const result = hit(EVERYTHING);

      expect(result).toEqual([]);
      expect(machines.list().every((m) => m.hp === 90)).toBe(true);
    });

    it('AC-048: a Capataz (Owner or Policeman) hitting a machine changes nothing @spec:AC-048', () => {
      hit(rectOf(M), 'policeman');
      hit(rectOf(M), 'owner');

      expect(hp()).toBe(100);
    });

    it('AC-049: an attack that does not reach the machine changes nothing @spec:AC-049', () => {
      hit(FAR);

      expect(machines.list().every((m) => m.hp === 100)).toBe(true);
    });

    it('AC-049: touching the machine\'s edge counts, one pixel short does not @spec:AC-049', () => {
      const body = rectOf(M);
      hit({ left: body.left - 30, right: body.left, top: body.top, bottom: body.bottom });
      expect(hp()).toBe(90);

      hit({ left: body.left - 30, right: body.left - 1, top: body.top, bottom: body.bottom });
      expect(hp()).toBe(90);
    });

    it('nothing wears a machine down outside a normal round: the countdown, the breaks and sudden death', () => {
      const countdown = new Match({ roomCode: 'AAAA-AAAA', players: roster, rounds: 4, map: DEFAULT_MAP, draw: () => 0 });
      const early = new Machines(map, countdown);
      early.hit(EVERYTHING, 'worker');
      expect(early.list().every((m) => m.hp === 100)).toBe(true);

      match.tick(ROUND_MS); // a break
      hit();
      expect(hp()).toBe(100);
    });

    it('AC-044: in sudden death hitting machines has no effect @spec:AC-044', () => {
      toSuddenDeath();

      hit(EVERYTHING);

      expect(machines.list().every((m) => m.hp === 100)).toBe(true);
      expect(broken).toEqual([]);
    });
  });

  describe('repairing', () => {
    it('AC-067: the Owner holding the key next to a damaged machine restores 5 integrity a second @spec:AC-067', () => {
      for (let i = 0; i < 5; i++) hit(); // 50

      repairFrames(60);

      expect(hp()).toBeCloseTo(55, 6);
    });

    it('AC-067: it goes on while the key is held, up to 100 and no further @spec:AC-067', () => {
      hit(); // 90

      repairFrames(60 * 2);
      expect(hp()).toBe(100);

      repairFrames(60);
      expect(hp()).toBe(100);
    });

    it('AC-067: a machine not within reach is not repaired @spec:AC-067', () => {
      hit();

      repairFrames(60, FAR);

      expect(hp()).toBe(90);
    });

    it('AC-067: an intact machine stays at 100 @spec:AC-067', () => {
      repairFrames(30);

      expect(hp()).toBe(100);
    });

    it('AC-068: a Policeman or an Operário holding the key repairs nothing @spec:AC-068', () => {
      for (let i = 0; i < 5; i++) hit();

      repairFrames(120, rectOf(M), 'policeman');
      repairFrames(120, rectOf(M), 'worker');

      expect(hp()).toBe(50);
    });

    it('AC-068: nobody repairs a machine that is already broken @spec:AC-068', () => {
      for (let i = 0; i < 10; i++) hit();

      repairFrames(600);

      expect(hp()).toBe(0);
      expect(machines.list().find((m) => m.id === M)!.broken).toBe(true);
    });

    it('AC-068: with a damaged and a broken machine in reach, only the damaged one is repaired @spec:AC-068', () => {
      // machine 1 and machine 3 are both in the EVERYTHING box
      hit(rectOf('machine3'));
      for (let i = 0; i < 10; i++) hit(rectOf('machine1'));
      expect(hp('machine1')).toBe(0);
      expect(hp('machine3')).toBe(90);

      repairFrames(120, EVERYTHING);

      expect(hp('machine1')).toBe(0);
      expect(hp('machine3')).toBe(100);
    });

    it('with two damaged machines in reach the nearest one is repaired first @spec:AC-067', () => {
      hit(rectOf('machine3'));
      hit(rectOf('machine4'));
      const near3 = rectOf('machine3');
      const reach = { left: near3.left, right: near3.left + 10, top: near3.top, bottom: near3.top + 10 };

      repairFrames(30, { ...reach, right: rectOf('machine4').right });

      // one of them got the repair, the other did not: never both at once
      const repaired = [hp('machine3'), hp('machine4')].filter((v) => v > 90);
      expect(repaired).toHaveLength(1);
    });

    it('repairing does not work outside a normal round', () => {
      hit();
      match.tick(ROUND_MS); // a break

      repairFrames(120);

      expect(hp()).toBe(90);
    });
  });

  describe('a new round', () => {
    it('AC-051: reset puts every machine back to 100 and intact @spec:AC-051', () => {
      for (let i = 0; i < 10; i++) hit(rectOf('machine1'));
      hit(rectOf('machine3'));

      machines.reset();

      expect(machines.list().every((m) => m.hp === 100 && !m.broken)).toBe(true);
    });

    it('AC-051: a machine broken before the reset can break again and is announced again @spec:AC-051', () => {
      for (let i = 0; i < 10; i++) hit();
      machines.reset();

      for (let i = 0; i < 10; i++) hit();

      expect(broken).toEqual([M, M]);
    });
  });

  it('asking for a machine that does not exist gives zero', () => {
    expect(machines.integrityOf('nope')).toBe(0);
  });
});
