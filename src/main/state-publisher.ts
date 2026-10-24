/** One read in flight, one pending refresh. Frequent activity must not starve the UI. */
export function statePublisher<T>(read: () => Promise<T>, publish: (value: T) => void, failed: (error: unknown) => void): () => void {
  let reading = false, dirty = false;
  return () => {
    dirty = true;
    if (reading) return;
    reading = true;
    void (async () => {
      try {
        do {
          dirty = false;
          try { publish(await read()); }
          catch (error) { failed(error); }
        } while (dirty);
      } finally { reading = false; }
    })();
  };
}
