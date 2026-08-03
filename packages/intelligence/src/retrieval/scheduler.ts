export interface SchedulerTask<T> {
  priority: number;
  run: () => Promise<T>;
}

export async function runPriorityTasks<T>(
  tasks: readonly SchedulerTask<T>[],
  maxConcurrency: number,
  signal: AbortSignal,
): Promise<T[]> {
  const queue = [...tasks].sort((left, right) => right.priority - left.priority);
  const results: T[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      if (signal.aborted)
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Aborted", "AbortError");
      const task = queue[cursor++];
      if (!task) return;
      results.push(await task.run());
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(maxConcurrency, queue.length || 1)) }, () =>
      worker(),
    ),
  );
  return results;
}
