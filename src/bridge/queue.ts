/**
 * Sequential send queue with configurable min-interval between jobs.
 */
export class SendQueue {
  private chain: Promise<void> = Promise.resolve();
  private lastSentAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.chain = this.chain
        .then(async () => {
          const wait = Math.max(0, this.lastSentAt + this.minIntervalMs - Date.now());
          if (wait > 0) {
            await new Promise((r) => setTimeout(r, wait));
          }
          try {
            const result = await fn();
            this.lastSentAt = Date.now();
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
}
