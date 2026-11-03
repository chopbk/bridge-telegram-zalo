import { describe, expect, it } from 'vitest';
import { SendQueue } from '../src/bridge/queue.js';

describe('SendQueue', () => {
  it('runs jobs sequentially with min interval', async () => {
    const q = new SendQueue(50);
    const times: number[] = [];
    const start = Date.now();

    await Promise.all([
      q.enqueue(async () => {
        times.push(Date.now() - start);
      }),
      q.enqueue(async () => {
        times.push(Date.now() - start);
      }),
    ]);

    expect(times).toHaveLength(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(45);
  });
});
