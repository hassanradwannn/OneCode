/** Run independent Remote reads together. Each task owns publication of only its own slice. */
export async function settleRemotePoll(tasks: Array<() => Promise<void>>): Promise<unknown[]> {
  const failures: unknown[] = [];
  let next = 0;
  // Leave headroom for a person's action and an explicit earlier-history read.
  await Promise.all(Array.from({ length: Math.min(3, tasks.length) }, async () => {
    for (;;) {
      const task = tasks[next++]; if (!task) return;
      try { await task(); } catch (error) { failures.push(error); }
    }
  }));
  return failures;
}
