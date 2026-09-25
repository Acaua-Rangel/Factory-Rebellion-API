import { walkoverWinner } from './walkover';

describe('walkoverWinner', () => {
  it('AC-046: nobody wins by walkover while both teams have players @spec:AC-046', () => {
    expect(walkoverWinner({ workers: 2, capatazes: 2 })).toBeNull();
    expect(walkoverWinner({ workers: 1, capatazes: 1 })).toBeNull();
  });

  it('AC-046: when the whole worker team is gone the capatazes win by walkover @spec:AC-046', () => {
    expect(walkoverWinner({ workers: 0, capatazes: 2 })).toBe('capatazes');
  });

  it('AC-046: when the whole capataz team is gone the workers win by walkover @spec:AC-046', () => {
    expect(walkoverWinner({ workers: 4, capatazes: 0 })).toBe('workers');
  });

  it('AC-046: a team with a single player left plays on @spec:AC-046', () => {
    expect(walkoverWinner({ workers: 1, capatazes: 2 })).toBeNull();
  });

  it('nobody left at all: there is no winner to name', () => {
    expect(walkoverWinner({ workers: 0, capatazes: 0 })).toBeNull();
  });
});
