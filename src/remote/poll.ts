/** Run independent Remote reads together. Each task owns publication of only its own slice. */
export async function settleRemotePoll(tasks: Array<() => Promise<void>>): Promise<unknown[]> {
  const results = await Promise.allSettled(tasks.map(task => task()));
  return results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
}
