export type TileQueueTask<T> = {
  key: string;
  scope: string;
  priority: number;
  run: (signal: AbortSignal) => Promise<T>;
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

  constructor(
    readonly maxConcurrent = 6,
    readonly maxPending = 400,
  ) {}

  get activeCount() {
    return this.active.size;
  }

  get pendingCount() {
    return this.pending.size;
  }

  enqueue(task: TileQueueTask<T>): Promise<T> {
    const running = this.active.get(task.key);
    if (running) return running.promise;
    const queued = this.pending.get(task.key);
    if (queued) {
      queued.priority = Math.min(queued.priority, task.priority);
      queued.scope = task.scope;
      queued.run = task.run;
      this.preemptFor(queued.priority);
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
    this.preemptFor(entry.priority);
    this.drain();
    return promise;
  }

  cancel(key: string, drain = true) {
    const queued = this.pending.get(key);
    if (queued) {
      this.pending.delete(key);
      queued.controller.abort();
      queued.reject(abortError());
    }
    const running = this.active.get(key);
    if (running) {
      this.active.delete(key);
      running.controller.abort();
      running.reject(abortError());
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
    }
  }

  private preemptFor(priority: number) {
    if (this.active.size < this.maxConcurrent) return;
    const worst = [...this.active.values()].sort(
      (left, right) => right.priority - left.priority || right.order - left.order,
    )[0];
    if (worst && worst.priority > priority) this.cancel(worst.key, false);
  }

  private drain() {
    while (this.active.size < this.maxConcurrent && this.pending.size) {
      const next = [...this.pending.values()].sort(
        (left, right) => left.priority - right.priority || left.order - right.order,
      )[0];
      if (!next) return;
      this.pending.delete(next.key);
      this.active.set(next.key, next);
      void next.run(next.controller.signal)
        .then(next.resolve, next.reject)
        .finally(() => {
          if (this.active.get(next.key) === next) this.active.delete(next.key);
          this.drain();
        });
    }
  }
}
