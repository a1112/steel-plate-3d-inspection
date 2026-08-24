export type TileQueueTask<T> = {
  key: string;
  scope: string;
  priority: number;
  estimatedBytes?: number;
  run: (signal: AbortSignal) => Promise<T>;
};

export type TileQueueTelemetry = {
  active: number;
  pending: number;
  activeBytes: number;
  pendingBytes: number;
  peakActive: number;
  peakActiveBytes: number;
  enqueued: number;
  deduplicated: number;
  completed: number;
  failed: number;
  cancelled: number;
  preempted: number;
  trimmed: number;
};

type QueuedTask<T> = TileQueueTask<T> & {
  order: number;
  controller: AbortController;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function abortError() {
  return new DOMException('Tile request cancelled', 'AbortError');
}

export class TileRequestQueue<T> {
  private readonly pending = new Map<string, QueuedTask<T>>();
  private readonly active = new Map<string, QueuedTask<T>>();
  private sequence = 0;
  private counters = {
    peakActive: 0,
    peakActiveBytes: 0,
    enqueued: 0,
    deduplicated: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    preempted: 0,
    trimmed: 0,
  };

  constructor(
    readonly maxConcurrent = 6,
    readonly maxPending = 400,
    readonly maxConcurrentBytes = 48 * 1024 * 1024,
  ) {}

  get activeCount() {
    return this.active.size;
  }

  get pendingCount() {
    return this.pending.size;
  }

  get activeBytes() {
    return [...this.active.values()].reduce(
      (total, task) => total + Math.max(0, task.estimatedBytes ?? 0),
      0,
    );
  }

  telemetry(): TileQueueTelemetry {
    return {
      active: this.activeCount,
      pending: this.pendingCount,
      activeBytes: this.activeBytes,
      pendingBytes: [...this.pending.values()].reduce(
        (total, task) => total + Math.max(0, task.estimatedBytes ?? 0),
        0,
      ),
      ...this.counters,
    };
  }

  enqueue(task: TileQueueTask<T>): Promise<T> {
    this.counters.enqueued += 1;
    const running = this.active.get(task.key);
    if (running) {
      this.counters.deduplicated += 1;
      return running.promise;
    }
    const queued = this.pending.get(task.key);
    if (queued) {
      this.counters.deduplicated += 1;
      queued.priority = Math.min(queued.priority, task.priority);
      queued.scope = task.scope;
      queued.estimatedBytes = task.estimatedBytes;
      queued.run = task.run;
      this.preemptFor(queued.priority, queued.estimatedBytes ?? 0);
      this.drain();
      return queued.promise;
    }

    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((accept, decline) => {
      resolve = accept;
      reject = decline;
    });
    const entry: QueuedTask<T> = {
      ...task,
      order: ++this.sequence,
      controller: new AbortController(),
      promise,
      resolve,
      reject,
    };
    this.pending.set(task.key, entry);
    this.trimPending();
    this.preemptFor(entry.priority, entry.estimatedBytes ?? 0);
    this.drain();
    return promise;
  }

  cancel(key: string, drain = true, reason: 'cancelled' | 'preempted' | 'trimmed' = 'cancelled') {
    const queued = this.pending.get(key);
    if (queued) {
      this.pending.delete(key);
      queued.controller.abort();
      queued.reject(abortError());
      this.counters[reason] += 1;
    }
    const running = this.active.get(key);
    if (running) {
      this.active.delete(key);
      running.controller.abort();
      running.reject(abortError());
      this.counters[reason] += 1;
    }
    if (drain) this.drain();
  }

  cancelScope(scope: string) {
    for (const [key, task] of this.pending) {
      if (task.scope === scope) this.cancel(key, false);
    }
    for (const [key, task] of this.active) {
      if (task.scope === scope) this.cancel(key, false);
    }
    this.drain();
  }

  cancelAll() {
    for (const key of [...this.pending.keys(), ...this.active.keys()]) this.cancel(key, false);
    this.drain();
  }

  private trimPending() {
    while (this.pending.size > this.maxPending) {
      const discard = [...this.pending.values()].sort(
        (left, right) => right.priority - left.priority || right.order - left.order,
      )[0];
      if (!discard) break;
      this.pending.delete(discard.key);
      discard.controller.abort();
      discard.reject(abortError());
      this.counters.trimmed += 1;
    }
  }

  private preemptFor(priority: number, estimatedBytes: number) {
    const exceedsCount = this.active.size >= this.maxConcurrent;
    const exceedsBytes = this.active.size > 0
      && this.activeBytes + Math.max(0, estimatedBytes) > this.maxConcurrentBytes;
    if (!exceedsCount && !exceedsBytes) return;
    const worst = [...this.active.values()].sort(
      (left, right) => right.priority - left.priority || right.order - left.order,
    )[0];
    if (worst && worst.priority > priority) {
      this.cancel(worst.key, false, 'preempted');
    }
  }

  private canStart(task: QueuedTask<T>) {
    if (this.active.size >= this.maxConcurrent) return false;
    if (this.active.size === 0) return true;
    return this.activeBytes + Math.max(0, task.estimatedBytes ?? 0)
      <= this.maxConcurrentBytes;
  }

  private drain() {
    while (this.active.size < this.maxConcurrent && this.pending.size) {
      const next = [...this.pending.values()].sort(
        (left, right) => left.priority - right.priority || left.order - right.order,
      ).find((task) => this.canStart(task));
      if (!next) return;
      this.pending.delete(next.key);
      this.active.set(next.key, next);
      this.counters.peakActive = Math.max(this.counters.peakActive, this.activeCount);
      this.counters.peakActiveBytes = Math.max(
        this.counters.peakActiveBytes,
        this.activeBytes,
      );
      void next.run(next.controller.signal)
        .then((value) => {
          this.counters.completed += 1;
          next.resolve(value);
        }, (reason) => {
          if (!next.controller.signal.aborted) this.counters.failed += 1;
          next.reject(reason);
        })
        .finally(() => {
          if (this.active.get(next.key) === next) this.active.delete(next.key);
          this.drain();
        });
    }
  }
}
