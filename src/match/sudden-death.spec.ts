import { suddenDeathOutcome } from './sudden-death';

describe('suddenDeathOutcome', () => {
  it('nobody wins while both teams still have someone standing', () => {
    expect(suddenDeathOutcome({ workers: 2, capatazes: 1 })).toBeNull();
    expect(suddenDeathOutcome({ workers: 1, capatazes: 1 })).toBeNull();
  });

  it('AC-043: when every worker is eliminated the capatazes win @spec:AC-043', () => {
    expect(suddenDeathOutcome({ workers: 0, capatazes: 2 })).toBe('capatazes');
    expect(suddenDeathOutcome({ workers: 0, capatazes: 1 })).toBe('capatazes');
  });

  it('AC-043: when every capataz is eliminated the workers win @spec:AC-043', () => {
    expect(suddenDeathOutcome({ workers: 3, capatazes: 0 })).toBe('workers');
  });

  it('AC-066: both teams wiped in the same tick is a tie @spec:AC-066', () => {
    expect(suddenDeathOutcome({ workers: 0, capatazes: 0 })).toBe('tie');
  });
});
