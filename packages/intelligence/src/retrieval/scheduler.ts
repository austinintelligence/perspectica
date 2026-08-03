export interface SchedulerTask<T> {
  priority: number;
  run: () => Promise<T>;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

/**
 * Start bounded work in priority order and yield each completed task as soon
 * as it settles. Returning from the consumer aborts the scheduler so a
 * provider can cancel in-flight network work instead of waiting for the
 * entire queue to drain.
 */
export async function* runPriorityTasksStream<T>(
  tasks: readonly SchedulerTask<T>[],
  maxConcurrency: number,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const queue = [...tasks].sort((left, right) => right.priority - left.priority);
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal.reason);
  if (signal.aborted) abortFromParent();
  else signal.addEventListener("abort", abortFromParent, { once: true });

  let cursor = 0;
  const inFlight = new Map<number, Promise<{ id: number; value?: T; error?: unknown }>>();
  let taskId = 0;
  const start = () => {
    const task = queue[cursor++];
    if (!task) return;
    const id = taskId++;
    const promise = task
      .run()
      .then((value) => ({ id, value }))
      .catch((error) => ({ id, error }));
    inFlight.set(id, promise);
  };

  try {
    const concurrency = Math.max(1, Math.min(maxConcurrency, queue.length || 1));
    while (inFlight.size < concurrency && cursor < queue.length) start();
    while (inFlight.size > 0) {
      if (controller.signal.aborted) throw abortError(controller.signal);
      const result = await Promise.race(inFlight.values());
      inFlight.delete(result.id);
      if (result.error !== undefined) throw result.error;
      if (result.value !== undefined) yield result.value;
      while (inFlight.size < concurrency && cursor < queue.length) start();
    }
  } finally {
    signal.removeEventListener("abort", abortFromParent);
    controller.abort();
  }
}

export async function runPriorityTasks<T>(
  tasks: readonly SchedulerTask<T>[],
  maxConcurrency: number,
  signal: AbortSignal,
): Promise<T[]> {
  const results: T[] = [];
  for await (const result of runPriorityTasksStream(tasks, maxConcurrency, signal)) {
    results.push(result);
  }
  return results;
}
