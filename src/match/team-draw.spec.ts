import { drawTeams } from './team-draw';

const roomOf = (size: number) =>
  Array.from({ length: size }, (_, i) => ({
    sessionId: `p${i + 1}`,
    nickname: `P${i + 1}`,
  }));

const count = <T>(items: T[], pick: (item: T) => boolean) =>
  items.filter(pick).length;

describe('Team and role draw', () => {
  it.each([4, 8])(
    'AC-034: exactly half of a room of %i are workers and half capatazes @spec:AC-034',
    (size) => {
      for (let i = 0; i < 50; i++) {
        const drawn = drawTeams(roomOf(size));

        expect(drawn).toHaveLength(size);
        expect(count(drawn, (p) => p.team === 'workers')).toBe(size / 2);
        expect(count(drawn, (p) => p.team === 'capatazes')).toBe(size / 2);
      }
    },
  );

  it.each([4, 8])(
    'AC-034: over 200 draws every player of a room of %i lands on both teams @spec:AC-034',
    (size) => {
      const seen = new Map<string, Set<string>>();
      for (let i = 0; i < 200; i++) {
        for (const player of drawTeams(roomOf(size))) {
          const teams = seen.get(player.sessionId) ?? new Set<string>();
          teams.add(player.team);
          seen.set(player.sessionId, teams);
        }
      }

      for (let i = 1; i <= size; i++) {
        expect(seen.get(`p${i}`)).toEqual(new Set(['workers', 'capatazes']));
      }
    },
  );

  it('AC-034: nobody is lost or duplicated by the draw @spec:AC-034', () => {
    const drawn = drawTeams(roomOf(8));

    expect(drawn.map((p) => p.sessionId).sort()).toEqual(
      roomOf(8)
        .map((p) => p.sessionId)
        .sort(),
    );
    expect(drawn.find((p) => p.sessionId === 'p3')?.nickname).toBe('P3');
  });

  it.each([4, 8])(
    'AC-035: a room of %i has exactly one Owner and the other capatazes are Policemen @spec:AC-035',
    (size) => {
      for (let i = 0; i < 50; i++) {
        const drawn = drawTeams(roomOf(size));
        const capatazes = drawn.filter((p) => p.team === 'capatazes');

        expect(count(capatazes, (p) => p.role === 'owner')).toBe(1);
        expect(count(capatazes, (p) => p.role === 'policeman')).toBe(
          size / 2 - 1,
        );
        expect(
          drawn
            .filter((p) => p.team === 'workers')
            .every((p) => p.role === 'worker'),
        ).toBe(true);
      }
    },
  );

  it.each([4, 8])(
    'AC-035: workers are split between the two looks as evenly as possible (room of %i) @spec:AC-035',
    (size) => {
      for (let i = 0; i < 50; i++) {
        const workers = drawTeams(roomOf(size)).filter(
          (p) => p.team === 'workers',
        );
        const op1 = count(workers, (p) => p.look === 'op1');
        const op2 = count(workers, (p) => p.look === 'op2');

        expect(op1 + op2).toBe(workers.length);
        expect(Math.abs(op1 - op2)).toBeLessThanOrEqual(1);
      }
    },
  );

  it('AC-035: only workers have a look; the Owner and Policemen have none @spec:AC-035', () => {
    const capatazes = drawTeams(roomOf(8)).filter(
      (p) => p.team === 'capatazes',
    );

    expect(capatazes.every((p) => p.look === null)).toBe(true);
  });

  it('AC-035: the Owner is picked at random among the capatazes @spec:AC-035', () => {
    const owners = new Set<string>();
    for (let i = 0; i < 300; i++) {
      owners.add(
        drawTeams(roomOf(4)).find((p) => p.role === 'owner')!.sessionId,
      );
    }

    // with 4 players every player can be the Owner sooner or later
    expect(owners.size).toBe(4);
  });

  it('is driven by the injected random source (deterministic when it is)', () => {
    const zero = () => 0;

    const a = drawTeams(roomOf(4), zero);
    const b = drawTeams(roomOf(4), zero);

    expect(a).toEqual(b);
  });

  it('refuses rooms that cannot be split in two equal teams', () => {
    expect(() => drawTeams(roomOf(5))).toThrow();
    expect(() => drawTeams([])).toThrow();
  });
});
