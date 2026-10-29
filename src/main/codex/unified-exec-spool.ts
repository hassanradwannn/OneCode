/** Durable custody for exited unified-exec output that has not been acknowledged. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { CHAT_PROVIDERS, type ChatProvider } from '../../shared/chat-provider.js';

export const EXEC_SPOOL_VERSION = 1;
export const MAX_EXEC_SPOOL_BYTES = 256 * 1024 * 1024;

export interface CompletedExecSpoolRecord {
  version: 1;
  processId: number;
  incarnation: number;
  ownerKind: 'anonymous' | 'request' | 'session';
  principal: string | null;
  provider?: ChatProvider;
  requestId?: string;
  sessionId?: string;
  conversationId?: string;
  setupProfileId?: string;
  command: string;
  cwd: string;
  startedAt: number;
  completedAt: number;
  exitCode: number | null;
  benignExit: boolean;
  outputClosed: boolean;
  outputInterrupted: boolean;
  outputCaptureIncomplete?: boolean;
  rawOutput: string;
  displayOutput?: string;
  pendingOutput: string;
  /** Bytes included in the initial exec response, separate from later background receipts. */
  initialOutputOffset?: number;
  outputOffsetBasis?: 'display';
  outputSha256: string;
  rawOmittedBytes: number;
  displayOmittedBytes: number;
  acknowledgedOffset: number;
}

export interface LiveExecSpoolRecord {
  version: 1;
  processId: number;
  incarnation: number;
  ownerKind: 'anonymous' | 'request' | 'session';
  principal: string | null;
  provider?: ChatProvider;
  requestId?: string;
  sessionId?: string;
  conversationId?: string;
  setupProfileId?: string;
  command: string;
  cwd: string;
  startedAt: number;
  rawOutput: string;
  displayOutput?: string;
  rawOmittedBytes: number;
  displayOmittedBytes: number;
}

export interface ExecAllocation { processId: number; incarnation: number }

export interface ExecSpool {
  initialize(): Promise<CompletedExecSpoolRecord[]>;
  allocate(): Promise<ExecAllocation>;
  putLive(record: LiveExecSpoolRecord): Promise<void>;
  updateLive(record: LiveExecSpoolRecord): Promise<void>;
  removeLive(processId: number, incarnation: number): Promise<void>;
  put(record: CompletedExecSpoolRecord): Promise<void>;
  update(record: CompletedExecSpoolRecord): Promise<void>;
  remove(processId: number): Promise<void>;
  removeIf(processId: number, incarnation: number, principal: string | null): Promise<boolean>;
  get(processId: number): CompletedExecSpoolRecord | null;
  list(): CompletedExecSpoolRecord[];
  bytes(): number;
}

/** One file per immutable completion keeps a single result commit atomic and bounds rewrites. */
export class FileExecSpool implements ExecSpool {
  private records = new Map<number, CompletedExecSpoolRecord>();
  private root: string;
  private byteCount = 0;
  private nextProcessId = 1_000;
  private nextIncarnation = 1;
  private idsExhausted = false;
  private live = new Map<number, LiveExecSpoolRecord>();
  private serial: Promise<void> = Promise.resolve();

  constructor(userDataDir: string) { this.root = path.join(userDataDir, 'exec-spool'); }

  async initialize(): Promise<CompletedExecSpoolRecord[]> {
    let rootPreviouslyExisted = true;
    try { await fs.lstat(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') rootPreviouslyExisted = false; else throw error; }
    await fs.mkdir(this.root, { recursive: true });
    const rootStat = await fs.lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Terminal spool directory is unavailable.');
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    let allocation = { version: 1, nextProcessId: 1_000, nextIncarnation: 1, idsExhausted: false };
    try {
      const allocatorPath = path.join(this.root, 'allocator.json');
      const allocatorStat = await fs.lstat(allocatorPath);
      if (!allocatorStat.isFile() || allocatorStat.isSymbolicLink()) throw new Error('invalid allocator file');
      const value = JSON.parse(await fs.readFile(allocatorPath, 'utf8')) as typeof allocation;
      if (value.version !== 1 || !Number.isSafeInteger(value.nextProcessId) || value.nextProcessId < 1_000 || value.nextProcessId > Number.MAX_SAFE_INTEGER ||
          !Number.isSafeInteger(value.nextIncarnation) || value.nextIncarnation < 1 ||
          (value.idsExhausted !== undefined && typeof value.idsExhausted !== 'boolean')) throw new Error('invalid allocator');
      allocation = { ...value, idsExhausted: value.idsExhausted === true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || rootPreviouslyExisted || entries.some(entry => /^\d{4,16}\.json$/.test(entry.name)))
        throw new Error('Terminal allocation history is unreadable; process ids will not be reused.');
    }
    const records = new Map<number, CompletedExecSpoolRecord>();
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !/^\d{4,16}\.json$/.test(entry.name)) continue;
      const file = path.join(this.root, entry.name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const raw = await fs.readFile(file, 'utf8');
      let record: CompletedExecSpoolRecord;
      try { record = validateRecord(JSON.parse(raw)); }
      catch { throw new Error('A retained terminal result is unreadable; no process was replayed or discarded.'); }
      if (path.basename(this.file(record.processId)) !== entry.name || records.has(record.processId))
        throw new Error('Retained terminal result identity is inconsistent.');
      records.set(record.processId, record);
      bytes += Buffer.byteLength(raw, 'utf8');
    }
    const liveDir = path.join(this.root, 'live');
    await fs.mkdir(liveDir, { recursive: true });
    const liveEntries = await fs.readdir(liveDir, { withFileTypes: true });
    const live = new Map<number, LiveExecSpoolRecord>();
    for (const entry of liveEntries) {
      if (!entry.isFile() || !/^\d{4,16}\.json$/.test(entry.name)) continue;
      const file = path.join(liveDir, entry.name), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      let operation: LiveExecSpoolRecord;
      try { operation = validateLiveRecord(JSON.parse(await fs.readFile(file, 'utf8'))); }
      catch { throw new Error('A live terminal custody record is unreadable; no process was replayed or discarded.'); }
      if (path.basename(this.liveFile(operation.processId)) !== entry.name || live.has(operation.processId))
        throw new Error('Live terminal custody identity is inconsistent.');
      live.set(operation.processId, operation);
    }
    const incarnationIds = new Map<number, number>();
    for (const operation of [...records.values(), ...live.values()]) {
      const priorId = incarnationIds.get(operation.incarnation);
      if (priorId !== undefined && priorId !== operation.processId)
        throw new Error('Terminal incarnation history is inconsistent; ids will not be reused.');
      incarnationIds.set(operation.incarnation, operation.processId);
    }
    for (const operation of live.values()) {
      const existing = records.get(operation.processId);
      if (existing && (existing.incarnation !== operation.incarnation || existing.ownerKind !== operation.ownerKind ||
          existing.principal !== operation.principal || existing.command !== operation.command || existing.cwd !== operation.cwd ||
          existing.startedAt !== operation.startedAt))
        throw new Error('Completed and live terminal custody identity is inconsistent.');
      if (!existing) {
        const output = Buffer.from(operation.rawOutput, 'base64');
        const interrupted: CompletedExecSpoolRecord = { ...operation, completedAt: Date.now(), exitCode: null,
          benignExit: false, outputClosed: false, outputInterrupted: true, outputCaptureIncomplete: true, pendingOutput: operation.rawOutput,
          outputSha256: createHash('sha256').update(output).digest('hex'), acknowledgedOffset: 0 };
        const encoded = JSON.stringify(interrupted);
        await this.writeFile(interrupted.processId, encoded);
        records.set(interrupted.processId, interrupted);
        bytes += Buffer.byteLength(encoded, 'utf8');
      }
      await fs.rm(this.liveFile(operation.processId), { force: true });
    }
    let highestId = 999, highestIncarnation = 0;
    for (const processId of records.keys()) highestId = Math.max(highestId, processId);
    for (const processId of live.keys()) highestId = Math.max(highestId, processId);
    for (const row of records.values()) highestIncarnation = Math.max(highestIncarnation, row.incarnation);
    for (const row of live.values()) highestIncarnation = Math.max(highestIncarnation, row.incarnation);
    if (highestId >= Number.MAX_SAFE_INTEGER) allocation.idsExhausted = true;
    else allocation.nextProcessId = Math.max(allocation.nextProcessId, highestId + 1);
    allocation.nextIncarnation = Math.max(allocation.nextIncarnation, highestIncarnation + 1);
    await this.writeAllocator(allocation.nextProcessId, allocation.nextIncarnation, allocation.idsExhausted);
    this.records = records;
    this.byteCount = bytes;
    this.live = new Map();
    this.nextProcessId = allocation.nextProcessId;
    this.nextIncarnation = allocation.nextIncarnation;
    this.idsExhausted = allocation.idsExhausted;
    return this.list();
  }

  allocate(): Promise<ExecAllocation> {
    return this.enqueue(async () => {
      if (this.idsExhausted) throw new Error('Terminal session id range is exhausted; no process was started.');
      const processId = this.nextProcessId;
      const incarnation = this.nextIncarnation++;
      this.idsExhausted = processId === Number.MAX_SAFE_INTEGER;
      if (!this.idsExhausted) this.nextProcessId++;
      await this.writeAllocator(this.nextProcessId, this.nextIncarnation, this.idsExhausted);
      const allocation = { processId, incarnation };
      return allocation;
    });
  }

  putLive(record: LiveExecSpoolRecord): Promise<void> {
    return this.enqueue(async () => {
      if (this.live.has(record.processId) || this.records.has(record.processId)) throw new Error('Terminal live custody identity already exists.');
      const size = Buffer.byteLength(JSON.stringify(record), 'utf8');
      if (this.byteCount + size > MAX_EXEC_SPOOL_BYTES) throw new Error('Terminal output storage is full; no process was started.');
      await this.writeLiveFile(record);
      this.live.set(record.processId, { ...record });
      this.byteCount += size;
    });
  }

  updateLive(record: LiveExecSpoolRecord): Promise<void> {
    return this.enqueue(async () => {
      const previous = this.live.get(record.processId);
      if (!previous) throw new Error('Terminal live custody record is unavailable.');
      const nextSize = Buffer.byteLength(JSON.stringify(record), 'utf8');
      const previousSize = Buffer.byteLength(JSON.stringify(previous), 'utf8');
      if (this.byteCount - previousSize + nextSize > MAX_EXEC_SPOOL_BYTES) throw new Error('Terminal output storage is full; live output checkpoint was not advanced.');
      await this.writeLiveFile(record);
      this.live.set(record.processId, { ...record });
      this.byteCount += nextSize - previousSize;
    });
  }

  removeLive(processId: number, incarnation: number): Promise<void> {
    return this.enqueue(async () => {
      const previous = this.live.get(processId);
      if (!previous || previous.incarnation !== incarnation) return;
      await fs.rm(this.liveFile(processId), { force: false });
      await this.syncRoot();
      this.live.delete(processId);
      this.byteCount -= Buffer.byteLength(JSON.stringify(previous), 'utf8');
    });
  }

  put(record: CompletedExecSpoolRecord): Promise<void> {
    return this.enqueue(async () => {
      const encoded = JSON.stringify(record);
      const size = Buffer.byteLength(encoded, 'utf8');
      const live = this.live.get(record.processId);
      const liveSize = live ? Buffer.byteLength(JSON.stringify(live), 'utf8') : 0;
      let committed = this.records.get(record.processId);
      const committedInMemory = committed !== undefined;
      if (committed && !sameCompletion(committed, record)) throw new Error('Terminal spool identity already exists with conflicting custody.');
      // Recover a row whose atomic file replacement succeeded before a later sync/live-cleanup
      // failure. Rewriting it could erase an acknowledged cursor, so validate and adopt it.
      if (!committed) {
        const target = this.file(record.processId);
        try {
          const stat = await fs.lstat(target);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Terminal result file is not a regular file.');
          const found = validateRecord(JSON.parse(await fs.readFile(target, 'utf8')));
          if (!sameCompletion(found, record)) throw new Error('Terminal spool identity already exists with conflicting custody.');
          committed = found;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      const committedSize = committed ? Buffer.byteLength(JSON.stringify(committed), 'utf8') : 0;
      if (this.byteCount - liveSize + (committedInMemory ? 0 : committed ? committedSize : size) > MAX_EXEC_SPOOL_BYTES)
        throw new Error('Terminal output storage is full; the process reservation remains held.');
      if (committed) {
        if (live) {
          await fs.rm(this.liveFile(record.processId), { force: false });
          const liveDir = path.dirname(this.liveFile(record.processId));
          if (process.platform !== 'win32') { const directory = await fs.open(liveDir, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); } }
          this.live.delete(record.processId);
        }
        this.records.set(record.processId, { ...committed });
        this.byteCount = this.byteCount - liveSize + (committedInMemory ? 0 : committedSize);
        return;
      }
      await this.writeFile(record.processId, encoded);
      if (live) {
        await fs.rm(this.liveFile(record.processId), { force: false });
        const liveDir = path.dirname(this.liveFile(record.processId));
        if (process.platform !== 'win32') { const directory = await fs.open(liveDir, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); } }
        this.live.delete(record.processId);
      }
      this.records.set(record.processId, { ...record });
      this.byteCount = this.byteCount - liveSize + size;
    });
  }

  update(record: CompletedExecSpoolRecord): Promise<void> {
    return this.enqueue(async () => {
      if (!this.records.has(record.processId)) throw new Error('Terminal spool result is unavailable.');
      const encoded = JSON.stringify(record);
      const nextBytes = Buffer.byteLength(encoded, 'utf8');
      const previousBytes = Buffer.byteLength(JSON.stringify(this.records.get(record.processId)), 'utf8');
      if (this.byteCount - previousBytes + nextBytes > MAX_EXEC_SPOOL_BYTES) throw new Error('Terminal output storage is full; acknowledgment was not committed.');
      await this.writeFile(record.processId, encoded);
      this.records.set(record.processId, { ...record });
      this.byteCount += nextBytes - previousBytes;
    });
  }

  remove(processId: number): Promise<void> {
    return this.enqueue(async () => {
      const previous = this.records.get(processId);
      if (!previous) return;
      await fs.rm(this.file(processId), { force: false });
      await this.syncRoot();
      this.records.delete(processId);
      this.byteCount -= Buffer.byteLength(JSON.stringify(previous), 'utf8');
    });
  }

  removeIf(processId: number, incarnation: number, principal: string | null): Promise<boolean> {
    return this.enqueue(async () => {
      const previous = this.records.get(processId);
      if (!previous || previous.incarnation !== incarnation || previous.principal !== principal) return false;
      await fs.rm(this.file(processId), { force: false });
      await this.syncRoot();
      this.records.delete(processId);
      this.byteCount -= Buffer.byteLength(JSON.stringify(previous), 'utf8');
      return true;
    });
  }

  get(processId: number): CompletedExecSpoolRecord | null { return this.records.get(processId) ?? null; }
  list(): CompletedExecSpoolRecord[] { return [...this.records.values()].map(record => ({ ...record })); }
  bytes(): number { return this.byteCount; }

  private file(processId: number): string {
    if (!Number.isSafeInteger(processId) || processId < 1_000) throw new Error('Invalid terminal spool id.');
    return path.join(this.root, `${processId}.json`);
  }

  private liveFile(processId: number): string {
    if (!Number.isSafeInteger(processId) || processId < 1_000) throw new Error('Invalid terminal live id.');
    return path.join(this.root, 'live', `${processId}.json`);
  }

  private async writeLiveFile(record: LiveExecSpoolRecord): Promise<void> {
    const target = this.liveFile(record.processId), temp = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await handle.writeFile(JSON.stringify(record), 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, target);
      const liveDir = path.dirname(target);
      if (process.platform !== 'win32') { const directory = await fs.open(liveDir, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); } }
    } finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
  }

  private async writeAllocator(nextProcessId: number, nextIncarnation: number, idsExhausted: boolean): Promise<void> {
    await this.writeMetadata(path.join(this.root, 'allocator.json'), JSON.stringify({ version: 1, nextProcessId, nextIncarnation, idsExhausted }));
  }

  private async writeMetadata(target: string, contents: string): Promise<void> {
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await handle.writeFile(contents, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, target); await this.syncRoot();
    } finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
  }

  private async writeFile(processId: number, contents: string): Promise<void> {
    const target = this.file(processId);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await handle.writeFile(contents, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, target);
      // On POSIX, syncing the containing directory makes the rename itself survive a crash
      // after the record contents were flushed. Windows does not expose portable directory
      // handles through Node, so the synced file remains the strongest available boundary.
      await this.syncRoot();
    } finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
  }

  private async syncRoot(): Promise<void> {
    if (process.platform === 'win32') return;
    const directory = await fs.open(this.root, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.serial.then(run);
    this.serial = next.then(() => undefined, () => undefined);
    return next;
  }
}

export class MemoryExecSpool implements ExecSpool {
  private records = new Map<number, CompletedExecSpoolRecord>();
  private live = new Map<number, LiveExecSpoolRecord>();
  private nextProcessId = 1_000;
  private nextIncarnation = 1;
  async initialize(): Promise<CompletedExecSpoolRecord[]> { return this.list(); }
  async allocate(): Promise<ExecAllocation> { return { processId: this.nextProcessId++, incarnation: this.nextIncarnation++ }; }
  async putLive(record: LiveExecSpoolRecord): Promise<void> { this.live.set(record.processId, { ...record }); }
  async updateLive(record: LiveExecSpoolRecord): Promise<void> { this.live.set(record.processId, { ...record }); }
  async removeLive(processId: number, incarnation: number): Promise<void> { if (this.live.get(processId)?.incarnation === incarnation) this.live.delete(processId); }
  async put(record: CompletedExecSpoolRecord): Promise<void> { this.records.set(record.processId, { ...record }); this.live.delete(record.processId); }
  async update(record: CompletedExecSpoolRecord): Promise<void> { this.records.set(record.processId, { ...record }); }
  async remove(processId: number): Promise<void> { this.records.delete(processId); }
  async removeIf(processId: number, incarnation: number, principal: string | null): Promise<boolean> {
    const previous = this.records.get(processId);
    if (!previous || previous.incarnation !== incarnation || previous.principal !== principal) return false;
    this.records.delete(processId);
    return true;
  }
  get(processId: number): CompletedExecSpoolRecord | null { return this.records.get(processId) ?? null; }
  list(): CompletedExecSpoolRecord[] { return [...this.records.values()].map(record => ({ ...record })); }
  bytes(): number { return [...this.records.values(), ...this.live.values()].reduce((n, record) => n + Buffer.byteLength(JSON.stringify(record)), 0); }
}

function validateRecord(value: unknown): CompletedExecSpoolRecord {
  if (!value || typeof value !== 'object') throw new Error('invalid record');
  let row = value as Partial<CompletedExecSpoolRecord>;
  // Older batch captures stored a raw-byte cursor against filtered display bytes.
  // Preserve both streams and reoffer output from zero only for this proved legacy
  // representation. This neither replays commands nor acknowledges unseen output.
  if (row.outputOffsetBasis === undefined && typeof row.rawOutput === 'string' &&
      typeof row.displayOutput === 'string' && row.displayOutput === row.pendingOutput &&
      row.rawOutput !== row.displayOutput && Number.isSafeInteger(row.initialOutputOffset) &&
      row.initialOutputOffset! >= 0 && Number.isSafeInteger(row.rawOmittedBytes) && row.rawOmittedBytes! >= 0 &&
      // The old cursor counted captured bytes before the bounded tail dropped them.
      // Its retained raw stream includes an omission marker; it is not the cursor's
      // original byte domain. Reset only this legacy representation, then validate
      // the retained streams and their original digest below as usual.
      row.initialOutputOffset! <= Buffer.from(row.rawOutput, 'base64').length + row.rawOmittedBytes!) {
    row = { ...row, initialOutputOffset: 0, outputOffsetBasis: 'display' };
  }
  if (row.version !== EXEC_SPOOL_VERSION || !Number.isSafeInteger(row.processId) ||
      !Number.isSafeInteger(row.incarnation) || !['anonymous', 'request', 'session'].includes(row.ownerKind ?? '') ||
      !(row.principal === null || typeof row.principal === 'string') ||
      (row.ownerKind === 'anonymous' && row.principal !== null) ||
      (row.ownerKind === 'request' && !row.principal?.startsWith('request:')) ||
      (row.ownerKind === 'session' && (!row.principal || row.principal.startsWith('request:'))) ||
      typeof row.command !== 'string' ||
      typeof row.cwd !== 'string' || !Number.isFinite(row.startedAt) || !Number.isFinite(row.completedAt) ||
      !(row.exitCode === null || Number.isInteger(row.exitCode)) || typeof row.benignExit !== 'boolean' ||
      typeof row.outputClosed !== 'boolean' ||
      (row.outputInterrupted !== undefined && typeof row.outputInterrupted !== 'boolean') ||
      (row.outputCaptureIncomplete !== undefined && typeof row.outputCaptureIncomplete !== 'boolean') ||
      (!row.outputClosed && row.outputInterrupted !== true) || (row.outputClosed && row.outputInterrupted === true) ||
      (row.provider !== undefined && !CHAT_PROVIDERS.includes(row.provider)) ||
      (row.outputOffsetBasis !== undefined && row.outputOffsetBasis !== 'display') ||
      typeof row.rawOutput !== 'string' || typeof row.pendingOutput !== 'string' ||
      (row.displayOutput !== undefined && typeof row.displayOutput !== 'string') ||
      typeof row.outputSha256 !== 'string' || !Number.isSafeInteger(row.rawOmittedBytes) ||
      !Number.isSafeInteger(row.displayOmittedBytes) || row.rawOmittedBytes! < 0 || row.displayOmittedBytes! < 0 ||
      !Number.isSafeInteger(row.acknowledgedOffset) || row.acknowledgedOffset! < 0 ||
      row.acknowledgedOffset! > Buffer.from(row.pendingOutput ?? '', 'base64').length ||
      (row.initialOutputOffset !== undefined && (!Number.isSafeInteger(row.initialOutputOffset) || row.initialOutputOffset < 0 ||
        row.initialOutputOffset > Buffer.from(row.pendingOutput ?? '', 'base64').length)) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.rawOutput ?? '') ||
      (row.displayOutput !== undefined && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.displayOutput)) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.pendingOutput ?? ''))
    throw new Error('invalid record');
  const digest = createHash('sha256').update(Buffer.from(row.rawOutput, 'base64')).digest('hex');
  if (digest !== row.outputSha256) throw new Error('digest mismatch');
  return { ...row, outputInterrupted: row.outputInterrupted === true, outputCaptureIncomplete: row.outputCaptureIncomplete === true } as CompletedExecSpoolRecord;
}

function sameCompletion(a: CompletedExecSpoolRecord, b: CompletedExecSpoolRecord): boolean {
  return a.processId === b.processId && a.incarnation === b.incarnation &&
    a.ownerKind === b.ownerKind && a.principal === b.principal &&
    a.command === b.command && a.cwd === b.cwd && a.startedAt === b.startedAt &&
    a.outputSha256 === b.outputSha256 && a.rawOutput === b.rawOutput &&
    a.pendingOutput === b.pendingOutput && a.initialOutputOffset === b.initialOutputOffset;
}

function validateLiveRecord(value: unknown): LiveExecSpoolRecord {
  if (!value || typeof value !== 'object') throw new Error('invalid live operation');
  const row = value as Partial<LiveExecSpoolRecord>;
  if (row.version !== 1 || !Number.isSafeInteger(row.processId) || row.processId! < 1_000 ||
      !Number.isSafeInteger(row.incarnation) || !['anonymous', 'request', 'session'].includes(row.ownerKind ?? '') ||
      !(row.principal === null || typeof row.principal === 'string') ||
      (row.ownerKind === 'anonymous' && row.principal !== null) ||
      (row.ownerKind === 'request' && !row.principal?.startsWith('request:')) ||
      (row.ownerKind === 'session' && (!row.principal || row.principal.startsWith('request:')) ) ||
      (row.provider !== undefined && !CHAT_PROVIDERS.includes(row.provider)) ||
      (row.requestId !== undefined && typeof row.requestId !== 'string') ||
      (row.sessionId !== undefined && typeof row.sessionId !== 'string') ||
      (row.conversationId !== undefined && typeof row.conversationId !== 'string') ||
      (row.setupProfileId !== undefined && typeof row.setupProfileId !== 'string') ||
      typeof row.command !== 'string' || typeof row.cwd !== 'string' ||
      !Number.isFinite(row.startedAt) || typeof row.rawOutput !== 'string' || typeof row.rawOmittedBytes !== 'number' ||
      typeof row.displayOmittedBytes !== 'number' || !Number.isSafeInteger(row.rawOmittedBytes) || !Number.isSafeInteger(row.displayOmittedBytes) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.rawOutput ?? '') ||
      (row.displayOutput !== undefined && (typeof row.displayOutput !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.displayOutput))))
    throw new Error('invalid live operation');
  return row as LiveExecSpoolRecord;
}
