import { matchOutcome, roundWinner } from './scoring';

const inPlay = {
  machinesTotal: 3,
  machinesBroken: 0,
  timeLeftMs: 30_000,
  workersActive: 2,
  workersDown: 0,
};

describe('roundWinner', () => {
  it('nobody wins while the round is still open', () => {
    expect(roundWinner(inPlay)).toBeNull();
    expect(
      roundWinner({
        ...inPlay,
        machinesBroken: 2,
        workersActive: 1,
        workersDown: 1,
      }),
    ).toBeNull();
  });

  it('AC-037: breaking the last standing machine before the clock ends gives the workers the round @spec:AC-037', () => {
    expect(roundWinner({ ...inPlay, machinesBroken: 3 })).toBe('workers');
    expect(roundWinner({ ...inPlay, machinesBroken: 3, timeLeftMs: 1 })).toBe(
      'workers',
    );
  });

  it('AC-037: breaking most, but not all, machines is not enough @spec:AC-037', () => {
    expect(roundWinner({ ...inPlay, machinesBroken: 2 })).toBeNull();
  });

  it('AC-038: the clock hitting zero with a machine still standing gives the capatazes the round @spec:AC-038', () => {
    expect(roundWinner({ ...inPlay, machinesBroken: 2, timeLeftMs: 0 })).toBe(
      'capatazes',
    );
    expect(roundWinner({ ...inPlay, timeLeftMs: -16 })).toBe('capatazes');
  });

  it('AC-038: one millisecond before the end nobody has won yet @spec:AC-038', () => {
    expect(roundWinner({ ...inPlay, timeLeftMs: 1 })).toBeNull();
  });

  it('AC-039: every worker incapacitated gives the capatazes the round at once @spec:AC-039', () => {
    expect(roundWinner({ ...inPlay, workersActive: 0, workersDown: 2 })).toBe(
      'capatazes',
    );
    expect(
      roundWinner({
        ...inPlay,
        workersActive: 0,
        workersDown: 4,
        timeLeftMs: 59_000,
      }),
    ).toBe('capatazes');
  });

  it('AC-039: one worker still standing keeps the round going @spec:AC-039', () => {
    expect(
      roundWinner({ ...inPlay, workersActive: 1, workersDown: 3 }),
    ).toBeNull();
  });

  it('a team with no workers playing yet (only spectators) does not lose the round by itself', () => {
    expect(
      roundWinner({ ...inPlay, workersActive: 0, workersDown: 0 }),
    ).toBeNull();
  });

  it('breaking the last machine wins even if the last worker fell in the same instant', () => {
    expect(
      roundWinner({
        ...inPlay,
        machinesBroken: 3,
        workersActive: 0,
        workersDown: 2,
      }),
    ).toBe('workers');
  });

  it('a map with no machines never ends by machines', () => {
    expect(roundWinner({ ...inPlay, machinesTotal: 0 })).toBeNull();
  });
});

describe('matchOutcome', () => {
  it.each([
    [{ workers: 2, capatazes: 0 }, 2, 4, 'workers'],
    [{ workers: 0, capatazes: 2 }, 2, 4, 'capatazes'],
    [{ workers: 3, capatazes: 1 }, 4, 4, 'workers'],
    [{ workers: 1, capatazes: 3 }, 4, 4, 'capatazes'],
    [{ workers: 4, capatazes: 2 }, 6, 6, 'workers'],
  ])(
    'AC-041: a 2-point lead wins the match (%j after %i rounds, limit %i) @spec:AC-041',
    (score, played, limit, winner) => {
      expect(matchOutcome(score, played, limit)).toEqual({
        kind: 'winner',
        team: winner,
      });
    },
  );

  it.each([
    [{ workers: 1, capatazes: 0 }, 1, 4],
    [{ workers: 1, capatazes: 1 }, 2, 4],
    [{ workers: 2, capatazes: 1 }, 3, 4],
    [{ workers: 2, capatazes: 2 }, 3, 5],
  ])(
    'AC-041: less than 2 points ahead before the limit keeps playing (%j after %i, limit %i) @spec:AC-041',
    (score, played, limit) => {
      expect(matchOutcome(score, played, limit)).toEqual({ kind: 'continue' });
    },
  );

  it.each([
    [{ workers: 2, capatazes: 2 }, 4, 4],
    [{ workers: 3, capatazes: 2 }, 5, 5],
    [{ workers: 3, capatazes: 3 }, 6, 6],
    [{ workers: 3, capatazes: 2 }, 5, 4],
  ])(
    'AC-042: no 2-point lead at the round limit means sudden death (%j after %i, limit %i) @spec:AC-042',
    (score, played, limit) => {
      expect(matchOutcome(score, played, limit)).toEqual({
        kind: 'sudden_death',
      });
    },
  );

  it('AC-042: a 2-point lead at the limit still wins instead of going to sudden death @spec:AC-042', () => {
    expect(matchOutcome({ workers: 3, capatazes: 1 }, 4, 4)).toEqual({
      kind: 'winner',
      team: 'workers',
    });
  });

  it('AC-042: the limit is per room: 4 rounds ends earlier than 6 @spec:AC-042', () => {
    const score = { workers: 2, capatazes: 2 };

    expect(matchOutcome(score, 4, 4)).toEqual({ kind: 'sudden_death' });
    expect(matchOutcome(score, 4, 6)).toEqual({ kind: 'continue' });
  });
});
