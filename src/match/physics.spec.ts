import { loadMap } from './map';
import { Body, GRAVITY, Input, JUMP_SPEED, Physics, SPEED } from './physics';

const NONE: Input = { left: false, right: false, jump: false, down: false };
const RIGHT: Input = { ...NONE, right: true };
const LEFT: Input = { ...NONE, left: true };
const JUMP: Input = { ...NONE, jump: true };
const DOWN: Input = { ...NONE, down: true };

describe('Server movement physics (a port of scripts/move.gml)', () => {
  const map = loadMap();
  const physics = new Physics(map);

  const run = (body: Body, input: Input, frames: number) => {
    for (let i = 0; i < frames; i++) physics.step(body, input);
  };
  // a body dropped at (x, y) and left to settle
  const settled = (x: number, y: number) => {
    const body = physics.createBody({ x, y });
    run(body, NONE, 120);
    return body;
  };

  it('the constants are the ones of the local game: 4 px per frame, gravity 0.4, jump 11.1 @spec:AC-061', () => {
    expect(SPEED).toBe(4);
    expect(GRAVITY).toBe(0.4);
    expect(JUMP_SPEED).toBe(11.1);
  });

  describe('walking', () => {
    it('AC-061: holding right for one second moves exactly 240 px @spec:AC-061', () => {
      const body = settled(100, 896);
      const startY = body.y;

      run(body, RIGHT, 60);

      expect(body.x).toBe(100 + 240);
      expect(body.y).toBe(startY); // still on the floor
    });

    it('AC-061: holding left for one second moves exactly 240 px to the left @spec:AC-061', () => {
      const body = settled(400, 896);

      run(body, LEFT, 60);

      expect(body.x).toBe(400 - 240);
    });

    it('AC-061: with no keys the player stays where they are @spec:AC-061', () => {
      const body = settled(300, 896);

      run(body, NONE, 60);

      expect(body.x).toBe(300);
    });

    it('AC-061: left and right together cancel out @spec:AC-061', () => {
      const body = settled(300, 896);

      run(body, { ...NONE, left: true, right: true }, 30);

      expect(body.x).toBe(300);
    });

    it('the player faces the way they last walked and keeps it when standing still', () => {
      const body = settled(300, 896);

      run(body, LEFT, 2);
      expect(body.facing).toBe(-1);
      run(body, NONE, 5);
      expect(body.facing).toBe(-1);
      run(body, RIGHT, 1);
      expect(body.facing).toBe(1);
    });
  });

  describe('the floor and the walls', () => {
    it('AC-061: a player dropped inside the room lands on the floor and stops there @spec:AC-061', () => {
      const body = settled(100, 800); // below the rope, above the floor

      // the floor's top row is 960: the player's feet (y + 63) stand on row 959
      expect(Math.round(body.y) + map.playerMask.bottom).toBe(959);
      expect(body.vspd).toBe(0);
      expect(physics.onGround(body)).toBe(true);
    });

    it('AC-061: the ropes across the room (y=236 and y=732) are platforms: a player dropped above one lands on it @spec:AC-061', () => {
      const body = settled(100, 600);

      // the rope's top row is 732: feet on row 731
      expect(Math.round(body.y) + map.playerMask.bottom).toBe(731);
      expect(physics.onGround(body)).toBe(true);
    });

    it('AC-061: the left wall stops the player at x = 28, the right wall at x = 2020 @spec:AC-061', () => {
      const left = settled(100, 896);
      run(left, LEFT, 100);
      const right = settled(100, 896);
      run(right, RIGHT, 600);

      expect(left.x).toBe(28);
      expect(right.x).toBe(2020);
      expect(left.hspd).toBe(0);
    });

    it('AC-061: pushing against a wall for a long time does not sink into it @spec:AC-061', () => {
      const body = settled(100, 896);

      run(body, LEFT, 1000);

      expect(body.x).toBe(28);
    });

    it('AC-061: a player cannot leave the room through the ceiling wall @spec:AC-061', () => {
      const body = settled(100, 896);

      for (let i = 0; i < 200; i++)
        physics.step(body, i % 40 === 0 ? JUMP : NONE);

      expect(Math.round(body.y) + map.playerMask.top).toBeGreaterThanOrEqual(0);
    });
  });

  describe('jumping', () => {
    it('AC-061: a jump from the floor rises 148.5 px and then falls back @spec:AC-061', () => {
      const body = settled(100, 896);
      const floorY = body.y;
      let apex = floorY;

      physics.step(body, JUMP);
      for (let i = 0; i < 200 && !physics.onGround(body); i++) {
        apex = Math.min(apex, body.y);
        physics.step(body, NONE);
      }

      // rising phase: 27 frames with speeds 10.7, 10.3, … 0.3 = 148.5 px
      expect(floorY - apex).toBeCloseTo(148.5, 5);
      // back on the floor (the sub-pixel rest position may differ by the way down)
      expect(Math.round(body.y)).toBe(Math.round(floorY));
    });

    it('AC-061: the first frame of a jump moves up by 10.7 px (gravity is added before the jump) @spec:AC-061', () => {
      const body = settled(100, 896);
      const before = body.y;

      physics.step(body, JUMP);

      expect(before - body.y).toBeCloseTo(JUMP_SPEED - GRAVITY, 10);
    });

    it('AC-061: pressing jump in the air does nothing @spec:AC-061', () => {
      const body = settled(100, 896);
      physics.step(body, JUMP);
      run(body, NONE, 10);
      const vspd = body.vspd;

      physics.step(body, JUMP);

      expect(body.vspd).toBeCloseTo(vspd + GRAVITY, 10);
    });

    it('AC-061: a jump while walking keeps the horizontal speed @spec:AC-061', () => {
      const body = settled(520, 896); // a clear stretch of floor, no machine beside it

      physics.step(body, { ...RIGHT, jump: true });
      run(body, RIGHT, 29);

      expect(body.x).toBe(520 + 30 * SPEED);
    });
  });

  describe('platforms you can stand on from above', () => {
    it('AC-061: a player above the upper level lands on it and stays @spec:AC-061', () => {
      const body = settled(2000, 400); // the capataz spawn

      expect(Math.round(body.y) + map.playerMask.bottom).toBe(463); // the level starts at row 464
      expect(physics.onGround(body)).toBe(true);
    });

    it('AC-061: pressing down drops the player through the platform they stand on @spec:AC-061', () => {
      const body = settled(2000, 400);

      run(body, DOWN, 40);

      expect(body.y).toBeGreaterThan(464);
    });

    it('AC-061: after dropping through, the player lands on the next platform, the rope, and can drop again to the floor @spec:AC-061', () => {
      const body = settled(2000, 400);

      run(body, DOWN, 30);
      run(body, NONE, 200);
      expect(Math.round(body.y) + map.playerMask.bottom).toBe(731); // the rope at y=732

      run(body, DOWN, 30);
      run(body, NONE, 200);
      expect(Math.round(body.y) + map.playerMask.bottom).toBe(959); // the floor
    });

    it('AC-061: a one-way platform beside the player blocks them sideways while it is solid, like in the game @spec:AC-061', () => {
      // the lower machine 3 is solid for a player whose feet are above its top
      // (row 852): jumping into its side at that height stops the walk for a frame
      const body = settled(100, 896);
      physics.step(body, { ...RIGHT, jump: true });
      let blocked = 0;
      for (let i = 0; i < 29; i++) {
        physics.step(body, RIGHT);
        if (body.hspd === 0) blocked++;
      }

      expect(blocked).toBeGreaterThan(0);
      expect(body.x).toBeLessThan(100 + 30 * SPEED);
    });

    it('AC-061: releasing down while falling through can land on the next platform below @spec:AC-061', () => {
      // the lamps at y=612 are platforms: drop from the level onto one of them
      const body = physics.createBody({ x: 764, y: 400 });
      run(body, NONE, 5);
      run(body, DOWN, 12);
      run(body, NONE, 120);

      // x=764 is over a lamp (742..785): the player ends on it, not on the floor
      expect(Math.round(body.y) + map.playerMask.bottom).toBe(611);
    });

    it('AC-061: thrown upward from below, a player passes through a platform and lands on top of it @spec:AC-061', () => {
      // the lamp at (764, 612) is a platform (top row 612); start well under it
      const body = physics.createBody({ x: 764, y: 780 });
      physics.step(body, NONE);
      body.vspd = -14; // a strong upward throw: rises about 245 px, through the lamp
      let highest = body.y;
      for (let i = 0; i < 250; i++) {
        physics.step(body, NONE);
        highest = Math.min(highest, body.y);
      }

      expect(highest + map.playerMask.bottom).toBeLessThan(612); // rose above it, so it did not block
      expect(Math.round(body.y) + map.playerMask.bottom).toBe(611); // and came down onto it
    });
  });

  describe('the server never trusts the client', () => {
    it('AC-062: extra fields in an input (a claimed position) change nothing @spec:AC-062', () => {
      const honest = settled(300, 896);
      const cheater = settled(300, 896);

      run(honest, RIGHT, 10);
      run(
        cheater,
        { ...RIGHT, x: 1900, y: 100, hspd: 999 } as unknown as Input,
        10,
      );

      expect(cheater.x).toBe(honest.x);
      expect(cheater.y).toBe(honest.y);
    });

    it('AC-062: a body only moves by the rules: no input can move it more than 4 px per frame sideways @spec:AC-062', () => {
      const body = settled(300, 896);

      for (let i = 0; i < 100; i++) {
        const before = body.x;
        physics.step(body, { left: true, right: true, jump: true, down: true });
        expect(Math.abs(body.x - before)).toBeLessThanOrEqual(SPEED);
      }
    });
  });

  it('is deterministic: the same inputs give the same result every time', () => {
    const script: Input[] = [
      RIGHT,
      RIGHT,
      JUMP,
      RIGHT,
      NONE,
      LEFT,
      DOWN,
      NONE,
      JUMP,
    ];
    const play = () => {
      const body = physics.createBody({ x: 500, y: 700 });
      for (let i = 0; i < 300; i++)
        physics.step(body, script[i % script.length]);
      return { ...body, solid: [...body.solid] };
    };

    expect(play()).toEqual(play());
  });

  describe('animation', () => {
    it('is idle standing, walk moving, jump rising and fall dropping', () => {
      const body = settled(300, 896);
      expect(physics.animationOf(body)).toBe('idle');

      physics.step(body, RIGHT);
      expect(physics.animationOf(body)).toBe('walk');

      physics.step(body, JUMP);
      expect(physics.animationOf(body)).toBe('jump');

      run(body, NONE, 40);
      const falling = physics.createBody({ x: 300, y: 600 });
      run(falling, NONE, 3);
      expect(physics.animationOf(falling)).toBe('fall');
    });

    it('is idle when walking into a wall', () => {
      const body = settled(28, 896);

      physics.step(body, LEFT);

      expect(physics.animationOf(body)).toBe('idle');
    });
  });
});
