import { createHash } from 'node:crypto';
import { readDurable, writeDurableNow } from '../durable.js';

interface Receipt { id: string; deviceId: string; hash: string; state: 'pending' | 'done'; result?: unknown; at: number }
/** An operation journal, never a scheduler. Lost replies read the original result; pending work is never replayed. */
export class RemoteOperations {
  private rows: Receipt[] | null = null;
  private lock: Promise<void> = Promise.resolve();
  private async serial<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.lock.then(run); this.lock = operation.then(() => undefined, () => undefined); return operation;
  }
  async get(id: string, deviceId: string): Promise<{ state: 'pending' | 'done'; result?: unknown } | null> {
    return this.serial(async () => {
      const rows = this.rows ?? await readDurable<Receipt[]>('remote-operations', { strict: true });
      if (rows && !Array.isArray(rows)) throw new Error('Remote operation journal is unreadable.');
      const row = rows?.find(row => row?.id === id && row.deviceId === deviceId);
      return row ? { state: row.state, ...(row.state === 'done' ? { result: row.result } : {}) } : null;
    });
  }
  async run(id: string, deviceId: string, body: unknown, action: () => Promise<unknown>): Promise<unknown> {
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const prior = await this.serial(async () => {
      if (!this.rows) {
        const rows = await readDurable<Receipt[]>('remote-operations', { strict: true });
        if (rows && (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== 'string' || !['pending', 'done'].includes(row.state) || typeof row.hash !== 'string')))
          throw new Error('Remote operation journal is unreadable.');
        this.rows = rows ?? [];
      }
      const row = this.rows.find(row => row.id === id);
      if (row) {
        if (row.deviceId !== deviceId || row.hash !== hash) throw new Error('Operation id belongs to a different request.');
        if (row.state === 'pending') throw new Error('Operation outcome is pending or unconfirmed. It will not be repeated.');
        return { found: true, result: row.result };
      }
      // Refuse when full: deleting an old id could turn a retry into a second mutation.
      if (this.rows.length >= 10_000) throw new Error('Remote operation history is full. No action was performed.');
      this.rows.push({ id, deviceId, hash, state: 'pending', at: Date.now() });
      await writeDurableNow('remote-operations', this.rows); return { found: false };
    });
    if (prior.found) return prior.result;
    let result: unknown;
    try { result = { ok: true, data: await action() }; }
    catch (error) { result = { ok: false, error: error instanceof Error ? error.message : 'Operation failed' }; }
    await this.serial(async () => {
      const row = this.rows!.find(row => row.id === id)!; row.state = 'done'; row.result = result;
      await writeDurableNow('remote-operations', this.rows);
    });
    return result;
  }
}
