import { Seat, seatOf, takeSeat } from './replacement';

describe('Open seats', () => {
  const owner = { team: 'capatazes', role: 'owner', look: null } as const;
  const worker = { team: 'workers', role: 'worker', look: 'op2' } as const;

  it('AC-072: a leaving player leaves behind a seat with the same team, role and look @spec:AC-072', () => {
    expect(
      seatOf({
        sessionId: 'a',
        nickname: 'A',
        team: 'workers',
        role: 'worker',
        look: 'op1',
        status: 'active',
        life: 3,
        position: { x: 1, y: 2 },
      }),
    ).toEqual({ team: 'workers', role: 'worker', look: 'op1' });
  });

  it('AC-072: the newcomer takes the seat that has been open the longest @spec:AC-072', () => {
    const open: Seat[] = [worker, owner];

    expect(takeSeat(open)).toEqual(worker);
    expect(takeSeat(open)).toEqual(owner);
    expect(open).toEqual([]);
  });

  it('AC-072: with no open seat there is nothing to take @spec:AC-072', () => {
    expect(takeSeat([])).toBeUndefined();
  });
});
