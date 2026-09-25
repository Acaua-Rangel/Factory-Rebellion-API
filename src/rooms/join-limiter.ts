const MAX_FAILURES = 10;
const WINDOW_MS = 60_000;
const BLOCK_MS = 60_000;

// Stops players from guessing room codes (AC-026): after 10 failed attempts
// within a minute, the player is blocked for 60 seconds. A successful join
// deliberately does NOT reset the counter, otherwise someone could join their
// own room every 9 guesses and never be stopped.
export class JoinLimiter {
  // Injectable clock so tests don't have to wait real minutes.
  clock: () => number = () => Date.now();

  private readonly failures = new Map<string, number[]>();
  private readonly blockedUntil = new Map<string, number>();

  isBlocked(sessionId: string): boolean {
    const until = this.blockedUntil.get(sessionId);
    if (until === undefined) {
      return false;
    }
    if (this.clock() >= until) {
      this.blockedUntil.delete(sessionId);
      this.failures.delete(sessionId);
      return false;
    }
    return true;
  }

  recordFailure(sessionId: string): void {
    const now = this.clock();
    const recent = (this.failures.get(sessionId) ?? []).filter(
      (at) => now - at < WINDOW_MS,
    );
    recent.push(now);
    this.failures.set(sessionId, recent);

    if (recent.length >= MAX_FAILURES) {
      this.blockedUntil.set(sessionId, now + BLOCK_MS);
    }
  }

  // Housekeeping so the maps don't grow forever.
  prune(): void {
    const now = this.clock();
    for (const [sessionId, times] of this.failures) {
      const stillCounts = times.some((at) => now - at < WINDOW_MS);
      if (!stillCounts && !this.blockedUntil.has(sessionId)) {
        this.failures.delete(sessionId);
      }
    }
    for (const [sessionId, until] of this.blockedUntil) {
      if (now >= until) {
        this.blockedUntil.delete(sessionId);
        this.failures.delete(sessionId);
      }
    }
  }

  trackedPlayers(): number {
    return this.failures.size;
  }
}
