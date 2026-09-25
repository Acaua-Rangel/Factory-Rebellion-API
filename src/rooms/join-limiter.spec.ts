import { JoinLimiter } from './join-limiter';

describe('JoinLimiter', () => {
  let limiter: JoinLimiter;
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    limiter = new JoinLimiter();
    limiter.clock = () => now;
  });

  const fail = (sessionId: string, times: number) => {
    for (let i = 0; i < times; i++) {
      limiter.recordFailure(sessionId);
    }
  };

  it('AC-026: 10 failed attempts within a minute are tolerated @spec:AC-026', () => {
    fail('a', 10);
    now += 60_001;

    expect(limiter.isBlocked('a')).toBe(false);
  });

  it('AC-026: the 11th attempt is refused after 10 failures @spec:AC-026', () => {
    fail('a', 10);
    now += 1_000;

    expect(limiter.isBlocked('a')).toBe(true);
  });

  it('AC-026: the block lasts 60 seconds, then the player can try again @spec:AC-026', () => {
    fail('a', 10);

    now += 59_000;
    expect(limiter.isBlocked('a')).toBe(true);
    now += 2_000;
    expect(limiter.isBlocked('a')).toBe(false);
  });

  it('AC-026: failures older than a minute do not add up @spec:AC-026', () => {
    fail('a', 9);
    now += 61_000;
    fail('a', 9);

    expect(limiter.isBlocked('a')).toBe(false);
  });

  it('AC-026: one player being blocked does not block the others @spec:AC-026', () => {
    fail('a', 10);

    expect(limiter.isBlocked('a')).toBe(true);
    expect(limiter.isBlocked('b')).toBe(false);
  });

  it('AC-026: a fresh start after the block: the counter is clean @spec:AC-026', () => {
    fail('a', 10);
    now += 61_000;
    fail('a', 9);

    expect(limiter.isBlocked('a')).toBe(false);
  });

  it('forgets players whose failures are all old', () => {
    fail('a', 3);
    now += 61_000;
    limiter.prune();

    expect(limiter.trackedPlayers()).toBe(0);
  });
});
