/**
 * Sequential send queue with min-interval and optional per-minute rate limit.
 */
export class SendQueue {
  private chain: Promise<void> = Promise.resolve();
  private lastSentAt = 0;
  private sendTimestamps: number[] = [];

  constructor(
    private readonly minIntervalMs: number,
    /** 0 = unlimited */
    private readonly maxPerMinute = 0,
    /** Sliding window length; default 1 minute. Overridable for tests. */
    private readonly windowMs = 60_000,
  ) {}

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.chain = this.chain
        .then(async () => {
          const intervalWait = Math.max(0, this.lastSentAt + this.minIntervalMs - Date.now());
          if (intervalWait > 0) {
            await sleep(intervalWait);
          }

          if (this.maxPerMinute > 0) {
            await this.waitForRateWindow();
          }

          try {
            const result = await fn();
            this.lastSentAt = Date.now();
            this.sendTimestamps.push(this.lastSentAt);
            resolve(result);
          } catch (err) {
            reject(err);
          }
        })
        .catch(() => {
          // keep chain alive after failures
        });
    });
  }

  private async waitForRateWindow(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.sendTimestamps = this.sendTimestamps.filter((t) => now - t < this.windowMs);
      if (this.sendTimestamps.length < this.maxPerMinute) return;
      const oldest = this.sendTimestamps[0]!;
      const waitMs = Math.max(1, this.windowMs - (now - oldest) + 1);
      await sleep(waitMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
