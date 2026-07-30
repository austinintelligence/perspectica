function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface RequestGateDiagnostics {
  queuedAt: number;
  startedAt: number;
  queueMs: number;
  active: number;
  limit: number;
}

/**
 * Small in-memory semaphore for one analysis runtime. It prevents free-tier
 * search providers from receiving a burst of every research lane at once.
 */
export class RequestGate {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("RequestGate requires a positive integer limit.");
    }
  }

  private release = (): void => {
    while (this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      if (waiter.signal?.aborted) continue;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(this.release);
      return;
    }
    this.active = Math.max(0, this.active - 1);
  };

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.release);
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  async run<T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
    onStarted?: (diagnostics: RequestGateDiagnostics) => void,
  ): Promise<T> {
    const queuedAt = Date.now();
    const release = await this.acquire(signal);
    const startedAt = Date.now();
    try {
      signal?.throwIfAborted();
      onStarted?.({
        queuedAt,
        startedAt,
        queueMs: Math.max(0, startedAt - queuedAt),
        active: this.active,
        limit: this.limit,
      });
      return await task();
    } finally {
      release();
    }
  }
}
