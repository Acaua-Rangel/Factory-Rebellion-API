import { RateLimiter } from './rate-limit';

describe('RateLimiter', () => {
  const burst = (limiter: RateLimiter, now: number, count: number) => {
    const results: string[] = [];
    for (let i = 0; i < count; i++) {
      results.push(limiter.check(now));
    }
    return results;
  };

  it('AC-013: lets 120 messages per second through and ignores the extra ones @spec:AC-013', () => {
    const limiter = new RateLimiter();
    const results = burst(limiter, 0, 150);

    expect(results.filter((r) => r === 'ok')).toHaveLength(120);
    expect(results.filter((r) => r === 'drop')).toHaveLength(30);
  });

  it('AC-013: the counter starts over every second @spec:AC-013', () => {
    const limiter = new RateLimiter();
    burst(limiter, 0, 150);

    expect(burst(limiter, 1000, 120).every((r) => r === 'ok')).toBe(true);
  });

  it('AC-013: a flood that lasts 5 seconds closes the connection @spec:AC-013', () => {
    const limiter = new RateLimiter();
    for (let second = 0; second < 4; second++) {
      expect(burst(limiter, second * 1000, 130)).not.toContain('close');
    }

    expect(burst(limiter, 4000, 130)).toContain('close');
  });

  it('AC-013: a flood that stops before 5 seconds is forgiven @spec:AC-013', () => {
    const limiter = new RateLimiter();
    for (let second = 0; second < 4; second++) {
      burst(limiter, second * 1000, 130);
    }
    // a calm second, then flooding again
    burst(limiter, 4000, 10);

    for (let second = 5; second < 9; second++) {
      expect(burst(limiter, second * 1000, 130)).not.toContain('close');
    }
  });

  it('AC-013: silence in between resets the flood streak @spec:AC-013', () => {
    const limiter = new RateLimiter();
    burst(limiter, 0, 130);
    burst(limiter, 1000, 130);
    burst(limiter, 2000, 130);
    // nothing during 3000–5999, then flooding again
    for (let second = 6; second < 9; second++) {
      expect(burst(limiter, second * 1000, 130)).not.toContain('close');
    }
  });
});
