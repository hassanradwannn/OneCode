/** Serve and Funnel share native configuration, so their publication transactions share this lock. */
let tail: Promise<void> = Promise.resolve();
export function withTailscaleMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = tail.then(operation); tail = result.then(() => undefined, () => undefined); return result;
}
