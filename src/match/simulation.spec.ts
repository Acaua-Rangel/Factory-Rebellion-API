import { loadMap } from './map';
import { HOLD_FRAMES, MAX_BATCH, MAX_QUEUE, Simulation } from './simulation';
import { Physics } from './physics';

const map = loadMap();
const spawn = { x: 520, y: 896 };

const key = (
  seq: number,
  keys: Partial<Record<'l' | 'r' | 'j' | 'f', number | boolean>> = {},
) => ({ seq, ...keys });

describe('Simulation (inputs to movement, one frame at a time)', () => {
  let sim: Simulation;

  beforeEach(() => {
    sim = new Simulation(new Physics(map));
    sim.add('ana', spawn);
    // let the body settle on the floor
    for (let i = 0; i < 60; i++) sim.step('ana', true);
  });

  const x = () => sim.bodyOf('ana')!.x;
  const frames = (n: number, canMove = true) => {
    for (let i = 0; i < n; i++) sim.step('ana', canMove);
  };
  const send = (inputs: unknown[]) => sim.enqueue('ana', { inputs });

  it('AC-061: holding right for 60 frames moves the player 240 px @spec:AC-061', () => {
    // the queue holds half a second: the client sends the next half as it goes
    send(Array.from({ length: 30 }, (_, i) => key(i + 1, { r: 1 })));
    frames(30);
    send(Array.from({ length: 30 }, (_, i) => key(i + 31, { r: 1 })));
    frames(30);

    expect(x()).toBe(spawn.x + 240);
  });

  it('AC-061: keys can be sent as 1/0 or true/false @spec:AC-061', () => {
    send([key(1, { r: true }), key(2, { r: 1 }), key(3, { l: 0, r: 1 })]);

    frames(3);

    expect(x()).toBe(spawn.x + 12);
  });

  it('AC-061: the server applies exactly one input per frame, however many arrive @spec:AC-061', () => {
    send(Array.from({ length: MAX_BATCH }, (_, i) => key(i + 1, { r: 1 })));

    frames(10);

    expect(x()).toBe(spawn.x + 10 * 4); // 10 frames, 10 inputs used
  });

  it('AC-060: the last applied input number is reported, so the client can correct its prediction @spec:AC-060', () => {
    send([key(1, { r: 1 }), key(2, { r: 1 }), key(3, { r: 1 }), key(4)]);
    expect(sim.ackOf('ana')).toBe(0);

    frames(2);
    expect(sim.ackOf('ana')).toBe(2);
    frames(2);
    expect(sim.ackOf('ana')).toBe(4);
  });

  it('AC-060: every player has their own acknowledged number @spec:AC-060', () => {
    sim.add('bia', { x: 700, y: 896 });
    sim.enqueue('bia', { inputs: [key(1), key(2), key(3), key(4), key(5)] });
    send([key(1), key(2)]);

    for (let i = 0; i < 3; i++) {
      sim.step('ana', true);
      sim.step('bia', true);
    }

    expect(sim.ackOf('ana')).toBe(2);
    expect(sim.ackOf('bia')).toBe(3);
  });

  it('AC-062: fields other than the four keys and the number are ignored, whatever they claim @spec:AC-062', () => {
    send([
      { seq: 1, r: 1, x: 5000, y: 5, hspd: 999, position: { x: 1, y: 1 } },
    ]);

    frames(1);

    expect(x()).toBe(spawn.x + 4);
    expect(sim.bodyOf('ana')!.y).toBeLessThan(900);
  });

  it('AC-062: a jump only counts on the frame it was sent, not held @spec:AC-062', () => {
    send([key(1, { j: 1 })]);

    frames(1);

    expect(sim.bodyOf('ana')!.vspd).toBeLessThan(0);
  });

  it.each([
    ['not an object', 'move right please'],
    ['no inputs list', {}],
    ['inputs is not a list', { inputs: 'r' }],
    ['null', null],
    ['undefined', undefined],
  ])('a malformed message (%s) is ignored @spec:AC-062', (_label, raw) => {
    expect(sim.enqueue('ana', raw)).toBe(0);
    frames(3);

    expect(x()).toBe(spawn.x);
  });

  it.each([
    ['no seq', { r: 1 }],
    ['a text seq', { seq: '1', r: 1 }],
    ['a fractional seq', { seq: 1.5, r: 1 }],
    ['a negative seq', { seq: -1, r: 1 }],
    ['an entry that is not an object', 'r'],
    ['null entry', null],
  ])(
    'an input with %s is dropped, the good ones around it are kept @spec:AC-062',
    (_label, bad) => {
      const accepted = send([key(1, { r: 1 }), bad, key(2, { r: 1 })]);
      frames(2);

      expect(accepted).toBe(2);
      expect(x()).toBe(spawn.x + 8);
    },
  );

  it('AC-062: an input number that does not go up (a replay) is dropped @spec:AC-062', () => {
    send([key(5, { r: 1 })]);
    frames(1);

    const accepted = send([
      key(5, { r: 1 }),
      key(3, { r: 1 }),
      key(6, { r: 1 }),
    ]);
    frames(1);

    expect(accepted).toBe(1); // only 6
    expect(x()).toBe(spawn.x + 8); // seq 5 earlier, seq 6 now: the replays added nothing
  });

  it('AC-062: at most one message worth of inputs is read at a time @spec:AC-062', () => {
    const accepted = send(
      Array.from({ length: MAX_BATCH + 20 }, (_, i) => key(i + 1)),
    );

    expect(accepted).toBe(MAX_BATCH);
  });

  it('AC-062: the queue is capped, so piling up inputs cannot store up speed @spec:AC-062', () => {
    let accepted = 0;
    for (let batch = 0; batch < 10; batch++) {
      accepted += send(
        Array.from({ length: MAX_BATCH }, (_, i) =>
          key(batch * MAX_BATCH + i + 1, { r: 1 }),
        ),
      );
    }

    expect(accepted).toBe(MAX_QUEUE);
    frames(500);
    // the 30 queued inputs, then the held key for HOLD_FRAMES, then nothing
    expect(x()).toBe(spawn.x + (MAX_QUEUE + HOLD_FRAMES) * 4);
  });

  it('when an input is late, the held keys are repeated for a few frames, then released', () => {
    send([key(1, { r: 1 })]);

    frames(1 + HOLD_FRAMES + 20);

    expect(x()).toBe(spawn.x + 4 * (1 + HOLD_FRAMES));
  });

  it('a late input never repeats a jump: the physics is given jump=false on repeated frames', () => {
    const physics = new Physics(map);
    const seen: boolean[] = [];
    const real = physics.step.bind(physics);
    jest.spyOn(physics, 'step').mockImplementation((body, input) => {
      seen.push(input.jump);
      real(body, input);
    });
    const spied = new Simulation(physics);
    spied.add('ana', spawn);
    spied.enqueue('ana', { inputs: [{ seq: 1, j: 1, r: 1 }] });

    for (let i = 0; i < 4; i++) spied.step('ana', true);

    // frame 1 has the real input (jump), frames 2-4 repeat the held keys without it
    expect(seen).toEqual([true, false, false, false]);
  });

  it('a player who cannot move ignores their inputs but they are acknowledged, and they do not fall or drift', () => {
    const before = { x: x(), y: sim.bodyOf('ana')!.y };
    send([key(1, { r: 1 }), key(2, { r: 1 }), key(3, { r: 1 })]);

    frames(5, false);

    expect(x()).toBe(before.x);
    expect(sim.bodyOf('ana')!.y).toBe(before.y);
    expect(sim.ackOf('ana')).toBe(3);
  });

  it('after being frozen the player moves again from the next inputs', () => {
    send([key(1, { r: 1 })]);
    frames(2, false);

    send([key(2, { r: 1 }), key(3, { r: 1 })]);
    frames(2);

    expect(x()).toBe(spawn.x + 8);
  });

  it('adding a player again puts a fresh body at the given place (round start)', () => {
    send([key(1, { r: 1 })]);
    frames(3);

    sim.add('ana', { x: 900, y: 896 });

    expect(sim.bodyOf('ana')!.x).toBe(900);
    expect(sim.bodyOf('ana')!.vspd).toBe(0);
  });

  it('removing a player forgets them', () => {
    sim.remove('ana');

    expect(sim.bodyOf('ana')).toBeUndefined();
    expect(sim.enqueue('ana', { inputs: [key(1)] })).toBe(0);
    expect(() => sim.step('ana', true)).not.toThrow();
  });

  it('resync lets a reloaded client start counting from 1 again', () => {
    send([key(1), key(2), key(3)]);
    frames(3);
    expect(sim.ackOf('ana')).toBe(3);

    sim.resync('ana');
    const accepted = send([key(1, { r: 1 })]);
    frames(1);

    expect(accepted).toBe(1);
    expect(sim.ackOf('ana')).toBe(1);
  });

  it('counts frames, for the snapshot tick number', () => {
    const before = sim.frame;

    sim.advance();
    sim.advance();

    expect(sim.frame).toBe(before + 2);
  });

  it('inputs for a player that has no body are ignored', () => {
    expect(sim.enqueue('stranger', { inputs: [key(1)] })).toBe(0);
  });
});
