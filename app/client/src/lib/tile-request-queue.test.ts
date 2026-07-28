import { describe, expect, it, vi } from 'vitest';
import { TileRequestQueue } from './tile-request-queue';

describe('TileRequestQueue', () => {
  it('limits concurrency and pending work', async () => {
    const queue = new TileRequestQueue<number>(6, 400);
    const releases: Array<() => void> = [];
    let peak = 0;
    const tasks = Array.from({ length: 450 }, (_, index) => queue.enqueue({
      key: `tile-${index}`,
      scope: 'record-a',
      priority: index < 20 ? 0 : 3,
      run: () => new Promise<number>((resolve) => {
        peak = Math.max(peak, queue.activeCount);
        releases.push(() => resolve(index));
      }),
    }).catch(() => -1));

    expect(queue.activeCount).toBe(6);
    expect(queue.pendingCount).toBe(400);
    while (queue.activeCount || queue.pendingCount) {
      releases.splice(0).forEach((release) => release());
      await Promise.resolve();
      await Promise.resolve();
    }
    await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(6);
  });

  it('deduplicates and promotes queued tasks', async () => {
    const queue = new TileRequestQueue<string>(1, 10);
    let release!: () => void;
    const first = queue.enqueue({
      key: 'active',
      scope: 'record-a',
      priority: 0,
      run: () => new Promise<string>((resolve) => {
        release = () => resolve('active');
      }),
    });
    const runner = vi.fn(async () => 'shared');
    const low = queue.enqueue({ key: 'shared', scope: 'record-a', priority: 3, run: runner });
    const promoted = queue.enqueue({ key: 'shared', scope: 'record-a', priority: 0, run: runner });
    expect(low).toBe(promoted);
    release();
    await expect(first).resolves.toBe('active');
    await expect(promoted).resolves.toBe('shared');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('cancels old record scopes', async () => {
    const queue = new TileRequestQueue<number>(1, 10);
    const active = queue.enqueue({
      key: 'old-active',
      scope: 'old',
      priority: 0,
      run: (signal) => new Promise<number>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    });
    const pending = queue.enqueue({
      key: 'old-pending',
      scope: 'old',
      priority: 1,
      run: async () => 2,
    });
    queue.cancelScope('old');
    await expect(active).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
