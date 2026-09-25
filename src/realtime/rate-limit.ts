export type RateVerdict = 'ok' | 'drop' | 'close';

// Per-connection flood guard (AC-013): at most `limit` messages per second are
// processed, the extra ones are dropped, and a flood that lasts
// `closeAfterWindows` consecutive seconds gets the connection closed.
export class RateLimiter {
  private windowStart: number | null = null;
  private count = 0;
  // consecutive completed windows that went over the limit
  private streak = 0;

  constructor(
    private readonly limit = 120,
    private readonly windowMs = 1000,
    private readonly closeAfterWindows = 5,
  ) {}

  check(now: number): RateVerdict {
    if (this.windowStart === null || now - this.windowStart >= this.windowMs) {
      const adjacent =
        this.windowStart !== null && now - this.windowStart < 2 * this.windowMs;
      this.streak = adjacent && this.count > this.limit ? this.streak + 1 : 0;
      this.windowStart = now;
      this.count = 0;
    }

    this.count++;
    if (this.count <= this.limit) {
      return 'ok';
    }
    return this.streak + 1 >= this.closeAfterWindows ? 'close' : 'drop';
  }
}
