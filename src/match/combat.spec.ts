import { loadMap } from './map';
import {
  DEFAULT_MAP,
  MAX_LIFE,
  Match,
  ROUND_MS,
  START_MS,
  INTERMISSION_MS,
} from './match-state';
import {
  BULLET_SPEED,
  Combat,
  HIT_ANIM_FRAMES,
  MELEE_COOLDOWN,
  MELEE_DAMAGE,
  MELEE_REACH,
  PISTOL_COOLDOWN,
  REVIVE_FRAMES,
  SHOT_DAMAGE,
} from './combat';
import { Physics } from './physics';
import { AppliedInput, Simulation } from './simulation';
import { Team } from './match.types';

const map = loadMap();
const physics = new Physics(map);

const roster = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    sessionId: `p${i + 1}`,
    nickname: `P${i + 1}`,
  }));

const KEYS = { left: false, right: false, jump: false, down: false };
const attack = (seq = 1): AppliedInput => ({
  ...KEYS,
  seq,
  attack: true,
  interact: false,
});
const hold = (seq = 1): AppliedInput => ({
  ...KEYS,
  seq,
  attack: false,
  interact: true,
});
const idle = (seq = 1): AppliedInput => ({
  ...KEYS,
  seq,
  attack: false,
  interact: false,
});

describe('Combat', () => {
  let match: Match;
  let sim: Simulation;
  let combat: Combat;

  // an 8-player match in its first round: 4 workers and 4 capatazes (one Owner)
  beforeEach(() => {
    match = new Match({
      roomCode: 'AAAA-AAAA',
      players: roster(8),
      rounds: 4,
      map: DEFAULT_MAP,
      draw: () => 0,
    });
    match.tick(START_MS);
    sim = new Simulation(physics);
    for (const p of match.view().players) sim.add(p.sessionId, p.position);
    combat = new Combat(map, match, sim);
  });

  const team = (t: Team) => match.view().players.filter((p) => p.team === t);
  const owner = () =>
    match.view().players.find((p) => p.role === 'owner')!.sessionId;
  const policemen = () =>
    match
      .view()
      .players.filter((p) => p.role === 'policeman')
      .map((p) => p.sessionId);
  const workers = () => team('workers').map((p) => p.sessionId);
  const life = (id: string) =>
    match.view().players.find((p) => p.sessionId === id)!.life;
  const status = (id: string) =>
    match.view().players.find((p) => p.sessionId === id)!.status;
  const body = (id: string) => sim.bodyOf(id)!;

  // stands players on the ground floor at the given x, facing right (1) or left (-1)
  const place = (id: string, x: number, facing: 1 | -1 = 1, y = 896) => {
    const b = body(id);
    b.x = x;
    b.y = y;
    b.vspd = 0;
    b.facing = facing;
  };
  // moves everybody else far away so they cannot be hit by accident
  const isolate = (...keep: string[]) => {
    let x = 1900;
    for (const p of match.view().players) {
      if (!keep.includes(p.sessionId)) {
        place(p.sessionId, (x -= 70), 1, 400);
      }
    }
  };
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) combat.frame();
  };

  describe('the Owner shoots, the others fight hand to hand', () => {
    it('AC-056: when the Owner attacks, a bullet leaves the pistol in the direction they face @spec:AC-056', () => {
      isolate(owner());
      place(owner(), 800, 1);

      combat.act(owner(), attack());

      expect(combat.bullets).toHaveLength(1);
      expect(combat.bullets[0]).toMatchObject({ dir: 1, ownerId: owner() });
      expect(combat.bullets[0].x).toBeGreaterThan(800); // in front of the Owner
    });

    it('AC-056: facing left, the bullet goes left @spec:AC-056', () => {
      isolate(owner());
      place(owner(), 800, -1);

      combat.act(owner(), attack());

      expect(combat.bullets[0].dir).toBe(-1);
      expect(combat.bullets[0].x).toBeLessThan(800);
    });

    it.each([
      ['a Policeman', () => policemen()[0]],
      ['an Operário', () => workers()[0]],
    ])(
      'AC-056: %s attacking never creates a bullet @spec:AC-056',
      (_label, who) => {
        const id = who();
        isolate(id);
        place(id, 800, 1);

        combat.act(id, attack());
        frames(5);

        expect(combat.bullets).toEqual([]);
      },
    );

    it('AC-056: the bullet flies straight at 10 px per frame @spec:AC-056', () => {
      isolate(owner());
      place(owner(), 800, 1);
      combat.act(owner(), attack());
      const x0 = combat.bullets[0].x;
      const y0 = combat.bullets[0].y;

      frames(10);

      expect(BULLET_SPEED).toBe(10);
      expect(combat.bullets[0].x).toBe(x0 + 100);
      expect(combat.bullets[0].y).toBe(y0);
    });

    it('AC-056: an input without the attack key does nothing @spec:AC-056', () => {
      isolate(owner());
      place(owner(), 800, 1);

      combat.act(owner(), idle());
      combat.act(owner(), undefined);

      expect(combat.bullets).toEqual([]);
    });
  });

  describe('cooldowns', () => {
    it('AC-057: the Owner cannot shoot again before 10 frames have passed @spec:AC-057', () => {
      isolate(owner());
      place(owner(), 800, 1);
      combat.act(owner(), attack(1));

      frames(PISTOL_COOLDOWN - 1);
      combat.act(owner(), attack(2));
      expect(combat.bullets).toHaveLength(1);

      frames(1);
      combat.act(owner(), attack(3));
      expect(combat.bullets).toHaveLength(2);
      expect(PISTOL_COOLDOWN).toBe(10);
    });

    it('AC-057: a melee attack cannot be repeated for half a second @spec:AC-057', () => {
      const [w] = workers();
      const victim = policemen()[0];
      isolate(w, victim);
      place(w, 800, 1);
      place(victim, 830, 1);
      combat.act(w, attack(1));
      expect(life(victim)).toBe(MAX_LIFE - MELEE_DAMAGE);

      frames(MELEE_COOLDOWN - 1);
      combat.act(w, attack(2));
      expect(life(victim)).toBe(MAX_LIFE - MELEE_DAMAGE); // too soon: nothing happened

      frames(1);
      combat.act(w, attack(3));
      expect(life(victim)).toBe(MAX_LIFE - 2 * MELEE_DAMAGE);
      expect(MELEE_COOLDOWN).toBe(30);
    });

    it('AC-057: cooldowns are per player @spec:AC-057', () => {
      const [a, b] = workers();
      isolate(a, b, policemen()[0]);
      place(a, 600, 1);
      place(b, 700, 1);
      place(policemen()[0], 660, 1);

      combat.act(a, attack(1));
      combat.act(b, attack(1));

      expect(life(policemen()[0])).toBe(MAX_LIFE - 2 * MELEE_DAMAGE); // both hit
    });

    it('a new round starts with no cooldown, no bullets and no revive in progress', () => {
      isolate(owner());
      place(owner(), 800, 1);
      combat.act(owner(), attack());

      combat.resetRound();

      expect(combat.bullets).toEqual([]);
      combat.act(owner(), attack(2));
      expect(combat.bullets).toHaveLength(1);
    });
  });

  describe('who gets hurt, and by how much', () => {
    it('AC-058: a bullet that reaches an enemy takes 1 half-heart and is used up @spec:AC-058', () => {
      const victim = workers()[0];
      isolate(owner(), victim);
      place(owner(), 800, 1);
      place(victim, 900, 1);
      combat.act(owner(), attack());

      frames(20);

      expect(life(victim)).toBe(MAX_LIFE - SHOT_DAMAGE);
      expect(combat.bullets).toEqual([]);
      expect(SHOT_DAMAGE).toBe(1);
    });

    it('AC-058: six shots take an enemy down @spec:AC-058', () => {
      const victim = workers()[0];
      isolate(owner(), victim);
      place(owner(), 800, 1);
      place(victim, 900, 1);

      for (let shot = 0; shot < 6; shot++) {
        combat.act(owner(), attack(shot + 1));
        frames(PISTOL_COOLDOWN + 12);
      }

      expect(status(victim)).toBe('incapacitated');
      expect(life(victim)).toBe(0);
    });

    it('AC-058: a melee hit takes 2 half-hearts from an enemy in reach @spec:AC-058', () => {
      const w = workers()[0];
      const victim = policemen()[0];
      isolate(w, victim);
      place(w, 800, 1);
      place(victim, 800 + 28 + 28 + MELEE_REACH - 10, 1); // just inside the reach

      combat.act(w, attack());

      expect(life(victim)).toBe(MAX_LIFE - MELEE_DAMAGE);
      expect(MELEE_DAMAGE).toBe(2);
    });

    it('AC-058: an enemy beyond the reach is not hit, and neither is one behind @spec:AC-058', () => {
      const w = workers()[0];
      const [far, behind] = policemen();
      isolate(w, far, behind);
      place(w, 800, 1);
      place(far, 800 + 28 + 28 + MELEE_REACH + 40, 1);
      place(behind, 700, 1);

      combat.act(w, attack());

      expect(life(far)).toBe(MAX_LIFE);
      expect(life(behind)).toBe(MAX_LIFE);
    });

    it('AC-058: a melee attack hits every enemy in reach, not just one @spec:AC-058', () => {
      const w = workers()[0];
      const [p1, p2] = policemen();
      isolate(w, p1, p2);
      place(w, 800, 1);
      place(p1, 860, 1);
      place(p2, 870, 1);

      combat.act(w, attack());

      expect(life(p1)).toBe(MAX_LIFE - MELEE_DAMAGE);
      expect(life(p2)).toBe(MAX_LIFE - MELEE_DAMAGE);
    });

    it('AC-058: melee follows the way the attacker faces @spec:AC-058', () => {
      const w = workers()[0];
      const victim = policemen()[0];
      isolate(w, victim);
      place(w, 800, -1);
      place(victim, 740, -1);

      combat.act(w, attack());

      expect(life(victim)).toBe(MAX_LIFE - MELEE_DAMAGE);
    });

    it('AC-058: an enemy at a different height, out of the attack box, is not hit @spec:AC-058', () => {
      const w = workers()[0];
      const victim = policemen()[0];
      isolate(w, victim);
      place(w, 800, 1);
      place(victim, 830, 1, 400); // on the upper level, far above

      combat.act(w, attack());

      expect(life(victim)).toBe(MAX_LIFE);
    });

    it('AC-058: a bullet is stopped by the solid wall of the room @spec:AC-058', () => {
      isolate(owner());
      place(owner(), 1990, 1); // the right wall starts at x = 2048
      combat.act(owner(), attack());
      expect(combat.bullets).toHaveLength(1);

      frames(5);

      expect(combat.bullets).toEqual([]);
    });

    it('AC-058: a bullet that leaves the room is removed @spec:AC-058', () => {
      isolate(owner());
      place(owner(), 1900, 1);
      combat.act(owner(), attack());

      frames(60);

      expect(combat.bullets).toEqual([]);
    });

    it('AC-058: a bullet flies over one-way platforms, only solid walls stop it @spec:AC-058', () => {
      // the lamp at (764, 612) is a one-way platform: a bullet at its height passes through
      isolate(owner());
      place(owner(), 700, 1, 608); // the bullet flies at y = 614: inside the lamp's box
      combat.act(owner(), attack());
      const y = combat.bullets[0].y;
      expect(y).toBeGreaterThanOrEqual(612);
      expect(y).toBeLessThanOrEqual(619);

      frames(12); // the bullet crosses x = 742..785, where the lamp is

      expect(combat.bullets).toHaveLength(1);
      expect(combat.bullets[0].y).toBe(y);
    });

    it('AC-058: what a client says about damage or life is not part of combat: only server state decides @spec:AC-058', () => {
      const w = workers()[0];
      isolate(w);

      // an input carrying invented fields is just an input: the extra fields do not exist for combat
      combat.act(w, {
        ...attack(),
        damage: 999,
        life: 100,
        target: 'p5',
      } as unknown as AppliedInput);

      expect(match.view().players.every((p) => p.life === MAX_LIFE)).toBe(true);
    });
  });

  describe('no friendly fire', () => {
    it('AC-054: a melee attack never hurts a teammate @spec:AC-054', () => {
      const [a, b] = workers();
      isolate(a, b);
      place(a, 800, 1);
      place(b, 830, 1);

      combat.act(a, attack());

      expect(life(b)).toBe(MAX_LIFE);
    });

    it("AC-054: the Owner's bullet passes through teammates without hurting them @spec:AC-054", () => {
      const mate = policemen()[0];
      const enemy = workers()[0];
      isolate(owner(), mate, enemy);
      place(owner(), 700, 1);
      place(mate, 800, 1); // in the line of fire
      place(enemy, 900, 1); // behind the teammate
      combat.act(owner(), attack());

      frames(40);

      expect(life(mate)).toBe(MAX_LIFE);
      expect(life(enemy)).toBe(MAX_LIFE - SHOT_DAMAGE);
    });

    it('AC-054: a melee attack hits the enemy standing next to a teammate, only the enemy @spec:AC-054', () => {
      const w = workers()[0];
      const mate = workers()[1];
      const enemy = policemen()[0];
      isolate(w, mate, enemy);
      place(w, 800, 1);
      place(mate, 820, 1);
      place(enemy, 850, 1);

      combat.act(w, attack());

      expect(life(mate)).toBe(MAX_LIFE);
      expect(life(enemy)).toBe(MAX_LIFE - MELEE_DAMAGE);
    });
  });

  describe('the fallen', () => {
    it("AC-055: a downed player's attack does nothing @spec:AC-055", () => {
      const w = workers()[0];
      const victim = policemen()[0];
      isolate(w, victim);
      place(w, 800, 1);
      place(victim, 830, 1);
      match.damage(w, MAX_LIFE);

      combat.act(w, attack());

      expect(life(victim)).toBe(MAX_LIFE);
    });

    it('AC-055: a downed Owner cannot shoot @spec:AC-055', () => {
      isolate(owner());
      place(owner(), 800, 1);
      match.damage(owner(), MAX_LIFE);

      combat.act(owner(), attack());

      expect(combat.bullets).toEqual([]);
    });

    it('AC-052: a downed player is not a target: hitting them again does nothing @spec:AC-052', () => {
      const w = workers()[0];
      const victim = policemen()[0];
      isolate(w, victim);
      place(w, 800, 1);
      place(victim, 830, 1);
      match.damage(victim, MAX_LIFE);

      combat.act(w, attack());

      expect(life(victim)).toBe(0);
      expect(status(victim)).toBe('incapacitated');
    });

    it('a bullet passes through a downed enemy', () => {
      const down = workers()[0];
      const target = workers()[1];
      isolate(owner(), down, target);
      place(owner(), 700, 1);
      place(down, 800, 1);
      place(target, 900, 1);
      match.damage(down, MAX_LIFE);
      combat.act(owner(), attack());

      frames(40);

      expect(life(target)).toBe(MAX_LIFE - SHOT_DAMAGE);
    });
  });

  describe('reviving a teammate', () => {
    // a downed policeman with a living policeman standing next to them
    const setupRevive = () => {
      const [downed, helper] = policemen();
      isolate(downed, helper);
      place(downed, 800, 1);
      place(helper, 830, 1);
      match.damage(downed, MAX_LIFE);
      return { downed, helper };
    };
    const holdFor = (helper: string, n: number) => {
      for (let i = 0; i < n; i++) {
        combat.act(helper, hold(i + 1));
        combat.frame();
      }
    };

    it('AC-069: holding the interact key next to a downed teammate for 3 seconds gets them up with 1 heart @spec:AC-069', () => {
      const { downed, helper } = setupRevive();

      holdFor(helper, REVIVE_FRAMES);

      expect(REVIVE_FRAMES).toBe(180);
      expect(status(downed)).toBe('active');
      expect(life(downed)).toBe(2);
    });

    it('AC-069: one frame short of 3 seconds is not enough @spec:AC-069', () => {
      const { downed, helper } = setupRevive();

      holdFor(helper, REVIVE_FRAMES - 1);

      expect(status(downed)).toBe('incapacitated');
    });

    it('AC-069: the progress of the revive can be shown over the downed player @spec:AC-069', () => {
      const { downed, helper } = setupRevive();

      holdFor(helper, REVIVE_FRAMES / 2);

      expect(combat.reviveProgress(downed)).toBeCloseTo(0.5, 2);
      expect(combat.reviveProgress(helper)).toBe(0);
    });

    it('AC-069: an enemy holding the key next to a downed player does nothing @spec:AC-069', () => {
      const { downed } = setupRevive();
      const enemy = workers()[0];
      place(enemy, 830, 1);

      for (let i = 0; i < REVIVE_FRAMES + 5; i++) {
        combat.act(enemy, hold(i + 1));
        combat.frame();
      }

      expect(status(downed)).toBe('incapacitated');
    });

    it('AC-069: a teammate too far away does not revive @spec:AC-069', () => {
      const { downed, helper } = setupRevive();
      place(helper, 1100, 1);

      holdFor(helper, REVIVE_FRAMES + 5);

      expect(status(downed)).toBe('incapacitated');
    });

    it('AC-069: the Owner can revive too, and a downed Owner can be revived @spec:AC-069', () => {
      const [helper] = policemen();
      isolate(owner(), helper);
      place(owner(), 800, 1);
      place(helper, 830, 1);
      match.damage(owner(), MAX_LIFE);

      holdFor(helper, REVIVE_FRAMES);

      expect(status(owner())).toBe('active');
    });

    it('AC-070: letting go of the key cancels the revive, and it starts over @spec:AC-070', () => {
      const { downed, helper } = setupRevive();
      holdFor(helper, 120);

      combat.act(helper, idle(500)); // key released
      combat.frame();
      expect(combat.reviveProgress(downed)).toBe(0);

      holdFor(helper, REVIVE_FRAMES - 1);
      expect(status(downed)).toBe('incapacitated'); // the 120 earlier frames do not count
    });

    it('AC-070: walking out of reach cancels the revive @spec:AC-070', () => {
      const { downed, helper } = setupRevive();
      holdFor(helper, 100);

      place(helper, 1200, 1); // far away
      holdFor(helper, 10);

      expect(combat.reviveProgress(downed)).toBe(0);
      expect(status(downed)).toBe('incapacitated');
    });

    it('AC-070: attacking cancels the revive @spec:AC-070', () => {
      const { downed, helper } = setupRevive();
      holdFor(helper, 100);

      combat.act(helper, { ...hold(200), attack: true });
      combat.frame();

      expect(combat.reviveProgress(downed)).toBe(0);
    });

    it('AC-070: the reviver being knocked down cancels the revive @spec:AC-070', () => {
      const { downed, helper } = setupRevive();
      holdFor(helper, 100);

      match.damage(helper, MAX_LIFE);
      combat.frame();

      expect(combat.reviveProgress(downed)).toBe(0);
      holdFor(helper, REVIVE_FRAMES); // a downed player cannot revive
      expect(status(downed)).toBe('incapacitated');
    });

    it('AC-070: once the downed player is back up (someone else finished first) the progress is dropped @spec:AC-070', () => {
      const { downed, helper } = setupRevive();
      holdFor(helper, 60);
      expect(combat.reviveProgress(downed)).toBeGreaterThan(0);

      match.revive(downed); // another teammate got there first
      combat.frame();

      expect(combat.reviveProgress(downed)).toBe(0);
    });

    it('AC-071: in sudden death nobody is revived, however long the key is held @spec:AC-071', () => {
      // play to sudden death: 2-2 after four rounds
      const m = new Match({
        roomCode: 'AAAA-AAAA',
        players: roster(8),
        rounds: 4,
        map: DEFAULT_MAP,
        draw: () => 0,
      });
      m.tick(START_MS);
      const win = (w: Team) => {
        if (w === 'workers') {
          DEFAULT_MAP.machineIds.forEach((id) => m.machineBroken(id));
          m.tick(16);
        } else {
          m.tick(ROUND_MS);
        }
        m.tick(INTERMISSION_MS);
      };
      (['workers', 'capatazes', 'workers', 'capatazes'] as Team[]).forEach(win);
      expect(m.view().phase).toBe('sudden_death');

      const s = new Simulation(physics);
      for (const p of m.view().players) s.add(p.sessionId, p.position);
      const c = new Combat(map, m, s);
      const capatazes = m.view().players.filter((p) => p.team === 'capatazes');
      const [down, help] = capatazes.filter((p) => p.role === 'policeman');
      s.bodyOf(down.sessionId)!.x = 800;
      s.bodyOf(help.sessionId)!.x = 830;
      s.bodyOf(down.sessionId)!.y = 896;
      s.bodyOf(help.sessionId)!.y = 896;
      m.damage(down.sessionId, MAX_LIFE);
      expect(
        m.view().players.find((p) => p.sessionId === down.sessionId)!.status,
      ).toBe('eliminated');

      for (let i = 0; i < REVIVE_FRAMES + 30; i++) {
        c.act(help.sessionId, hold(i + 1));
        c.frame();
      }

      expect(
        m.view().players.find((p) => p.sessionId === down.sessionId)!.status,
      ).toBe('eliminated');
      expect(c.reviveProgress(down.sessionId)).toBe(0);
    });
  });

  describe('holding interact with nobody to revive', () => {
    type Seen = {
      playerId: string;
      role: string;
      reach: { left: number; right: number; top: number; bottom: number };
    };
    const listen = () => {
      const seen: Seen[] = [];
      combat.onInteract((e) => seen.push(e));
      return seen;
    };

    it('AC-067: it is announced with the player and their reach, so the Owner can repair @spec:AC-067', () => {
      isolate(owner());
      place(owner(), 800, 1);
      const seen = listen();

      combat.act(owner(), hold());

      expect(seen).toEqual([
        {
          playerId: owner(),
          role: 'owner',
          reach: {
            left: 772 - 56,
            right: 827 + 56,
            top: 840 - 16,
            bottom: 959 + 16,
          },
        },
      ]);
    });

    it('AC-067: every frame the key is held counts, so repairing goes on while it is @spec:AC-067', () => {
      isolate(owner());
      place(owner(), 800, 1);
      const seen = listen();

      for (let i = 0; i < 5; i++) combat.act(owner(), hold(i + 1));

      expect(seen).toHaveLength(5);
    });

    it('AC-067: without the key held, or on an attack, nothing is announced @spec:AC-067', () => {
      isolate(owner());
      place(owner(), 800, 1);
      const seen = listen();

      combat.act(owner(), idle());
      combat.act(owner(), { ...hold(2), attack: true });
      combat.act(owner(), undefined);

      expect(seen).toEqual([]);
    });

    it('AC-068: reviving a downed teammate has priority: then it is not announced @spec:AC-068', () => {
      const helper = policemen()[0];
      isolate(owner(), helper);
      place(owner(), 800, 1);
      place(helper, 830, 1);
      match.damage(helper, MAX_LIFE);
      const seen = listen();

      combat.act(owner(), hold());

      expect(seen).toEqual([]);
      expect(combat.reviveProgress(helper)).toBeGreaterThan(0);
    });

    it('a downed player holding interact announces nothing', () => {
      isolate(owner());
      place(owner(), 800, 1);
      match.damage(owner(), MAX_LIFE);
      const seen = listen();

      combat.act(owner(), hold());

      expect(seen).toEqual([]);
    });
  });

  describe('what the others see', () => {
    it('after a melee attack the attacker shows the hit animation for a short while', () => {
      const w = workers()[0];
      isolate(w);
      place(w, 800, 1);
      expect(combat.animOf(w)).toBeUndefined();

      combat.act(w, attack());
      expect(combat.animOf(w)).toBe('hit');

      frames(HIT_ANIM_FRAMES);
      expect(combat.animOf(w)).toBeUndefined();
    });

    it('the Owner shooting does not use the melee animation', () => {
      isolate(owner());
      place(owner(), 800, 1);

      combat.act(owner(), attack());

      expect(combat.animOf(owner())).toBeUndefined();
    });

    it('a melee attack is announced with its box, for whatever it may break (machines)', () => {
      const w = workers()[0];
      isolate(w);
      place(w, 800, 1);
      const seen: unknown[] = [];
      combat.onMelee((e) => seen.push(e));

      combat.act(w, attack());

      expect(seen).toEqual([
        {
          attackerId: w,
          role: 'worker',
          rect: { left: 772, right: 827 + MELEE_REACH, top: 840, bottom: 959 },
        },
      ]);
    });

    it('a player who leaves is forgotten: their bullets stay, nothing else remains', () => {
      isolate(owner());
      place(owner(), 800, 1);
      combat.act(owner(), attack());

      combat.forget(owner());

      expect(() => frames(5)).not.toThrow();
    });
  });
});
