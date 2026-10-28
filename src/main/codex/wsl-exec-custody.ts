/** Durable custody for Linux processes started through WSL by unified exec. */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface WslProcessIdentity { distro: string; pid: number; startTime: string }
export type WslCustodyState = 'pending' | 'tagged' | 'termination-unknown';

export interface WslExecCustodyRecord {
  version: 1;
  processId: number;
  incarnation: number;
  ownerPrincipal: string | null;
  command: string;
  startedAt: number;
  runToken: string;
  state: WslCustodyState;
  /** Set only after the Windows exec leader has exited; only then can an empty WSL scan retire custody. */
  leaderExited: boolean;
  identities: WslProcessIdentity[];
  lastScanAt: number | null;
  lastError: string | null;
}

export interface WslExecCustodyPublicRow {
  processId: number;
  incarnation: number;
  command: string;
  startedAt: number;
  detachedWsl: true;
  terminationState: WslCustodyState;
}

export interface WslCommandResult { code: number | null; stdout: Buffer; stderr: Buffer; error?: Error }
export type WslCommandRunner = (args: string[], timeoutMs: number) => Promise<WslCommandResult>;
export type WslRegistryProbe = () => Promise<'empty' | 'present' | 'unknown'>;

const TOKEN_NAME = 'ONECODE_EXEC_RUN_ID';
const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;
const MAX_DISTROS = 32;
const MAX_CAPTURE = 512 * 1024;
const COMMAND_TIMEOUT_MS = 5_000;
const SCAN_SCRIPT = String.raw`token=$1
status=0
for envfile in /proc/[0-9]*/environ; do
  pid=$(printf '%s' "$envfile" | sed 's#^/proc/##;s#/environ$##')
  envdata=$(tr '\000' '\n' < "$envfile" 2>/dev/null) || { [ ! -d "/proc/$pid" ] || status=2; continue; }
  printf '%s\n' "$envdata" | grep -Fxq "${TOKEN_NAME}=$token" || continue
  statdata=$(cat "/proc/$pid/stat" 2>/dev/null) || { [ ! -d "/proc/$pid" ] || status=2; continue; }
  rest=$(printf '%s' "$statdata" | sed 's/.*) //')
  start=$(printf '%s\n' "$rest" | awk '{print $20}')
  case "$pid:$start" in *[!0-9:]*) status=2; continue ;; esac
  printf 'MATCH %s %s\n' "$pid" "$start"
done
printf 'DONE %s\n' "$status"`;
const SIGNAL_SCRIPT = String.raw`token=$1; wanted=$2; startwanted=$3; signal=$4
statdata=$(cat "/proc/$wanted/stat" 2>/dev/null) || exit 23
rest=$(printf '%s' "$statdata" | sed 's/.*) //'); actual=$(printf '%s\n' "$rest" | awk '{print $20}')
[ "$actual" = "$startwanted" ] || exit 24
envdata=$(tr '\000' '\n' < "/proc/$wanted/environ" 2>/dev/null) || exit 21
printf '%s\n' "$envdata" | grep -Fxq "${TOKEN_NAME}=$token" || exit 22
kill -"$signal" "$wanted"`;
const LxssRegistryProbeScript = String.raw`$ErrorActionPreference = 'Stop'
try {
  $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Default)
  $key = $root.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Lxss', $false)
  if ($null -eq $key) { [Console]::Out.WriteLine('NO_LXSS_KEY'); exit 0 }
  $children = $key.GetSubKeyNames()
  if ($children.Length -eq 0) { [Console]::Out.WriteLine('NO_REGISTERED_DISTROS'); exit 0 }
  [Console]::Out.WriteLine('REGISTERED_DISTROS_PRESENT')
  exit 0
} catch { [Console]::Error.WriteLine('REGISTRY_PROBE_FAILED'); exit 12 }`;

function probeRegisteredWslDistros(): Promise<'empty' | 'present' | 'unknown'> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', LxssRegistryProbeScript],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { resolve('unknown'); return; }
    const stdout: Buffer[] = [];
    let settled = false;
    const finish = (state: 'empty' | 'present' | 'unknown'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(state);
    };
    child.stdout?.on('data', (chunk: Buffer) => { if (Buffer.concat(stdout).length < 4096) stdout.push(chunk.subarray(0, 4096)); });
    child.once('error', () => finish('unknown'));
    child.once('close', code => {
      if (code !== 0) { finish('unknown'); return; }
      const result = Buffer.concat(stdout).toString('utf8').trim();
      finish(result === 'NO_LXSS_KEY' || result === 'NO_REGISTERED_DISTROS' ? 'empty'
        : result === 'REGISTERED_DISTROS_PRESENT' ? 'present' : 'unknown');
    });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already closed */ } finish('unknown'); }, COMMAND_TIMEOUT_MS);
  });
}

function validateRecord(value: unknown): WslExecCustodyRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid WSL custody record.');
  const row = value as WslExecCustodyRecord;
  if (row.version !== 1 || !Number.isSafeInteger(row.processId) || row.processId < 1_000 ||
      !Number.isSafeInteger(row.incarnation) || row.incarnation < 1 ||
      !(row.ownerPrincipal === null || typeof row.ownerPrincipal === 'string') ||
      typeof row.command !== 'string' || !Number.isFinite(row.startedAt) ||
      typeof row.runToken !== 'string' || !/^[0-9a-f]{64}$/.test(row.runToken) ||
      !['pending', 'tagged', 'termination-unknown'].includes(row.state) ||
      !(row.leaderExited === undefined || typeof row.leaderExited === 'boolean') ||
      !Array.isArray(row.identities) || row.identities.length > MAX_DISTROS * 1024 ||
      !(row.lastScanAt === null || Number.isFinite(row.lastScanAt)) ||
      !(row.lastError === null || typeof row.lastError === 'string')) throw new Error('Invalid WSL custody record.');
  for (const identity of row.identities) {
    if (!identity || typeof identity.distro !== 'string' || !identity.distro || identity.distro.length > 256 ||
        !Number.isSafeInteger(identity.pid) || identity.pid < 1 || !/^\d+$/.test(identity.startTime))
      throw new Error('Invalid WSL process identity.');
  }
  // The field was added compatibly: older v1 custody records always mean the leader's
  // completion was not durably observed, so keep them conservative until revalidation.
  return { ...row, leaderExited: row.leaderExited ?? false };
}

export function runWslCommand(args: string[], timeoutMs: number): Promise<WslCommandResult> {
  return new Promise(resolve => {
    let child;
    try {
      const env = { ...process.env };
      delete env[TOKEN_NAME];
      child = spawn('wsl.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (error) { resolve({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: error as Error }); return; }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outBytes = 0, errBytes = 0, settled = false;
    const finish = (result: WslCommandResult): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const append = (target: Buffer[], chunk: Buffer, current: number): number => {
      const accepted = chunk.subarray(0, Math.max(0, MAX_CAPTURE - current));
      if (accepted.length) target.push(accepted);
      return current + accepted.length;
    };
    child.stdout?.on('data', (chunk: Buffer) => { outBytes = append(stdout, chunk, outBytes); });
    child.stderr?.on('data', (chunk: Buffer) => { errBytes = append(stderr, chunk, errBytes); });
    child.once('error', error => finish({ code: null, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), error }));
    child.once('close', code => finish({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    const timer = setTimeout(() => { try { child.kill(); } catch { /* closed */ }
      finish({ code: null, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), error: new Error('WSL command timed out.') }); }, timeoutMs);
  });
}

function decodeWslOutput(buffer: Buffer): string {
  // `wsl.exe --list` is UTF-16LE on Windows. Exec output from a distro is UTF-8.
  if (buffer.length >= 2 && buffer[1] === 0) return buffer.toString('utf16le').replace(/^\uFEFF/, '');
  return buffer.toString('utf8');
}

/** Read-only OS evidence: a Windows process cannot survive a full Windows boot. */
async function windowsBootTime(): Promise<number | null> {
  if (process.platform !== 'win32') return null;
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; [Console]::WriteLine(([DateTimeOffset](Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()).ToUnixTimeMilliseconds())"],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', done = false;
    const finish = (value: number | null) => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(null); }, 10000);
    child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 1024) { child.kill(); finish(null); } });
    child.once('error', () => finish(null));
    child.once('close', code => { const value = Number(output.trim()); finish(code === 0 && Number.isSafeInteger(value) && value > 0 && value <= Date.now() ? value : null); });
  });
}

export class FileWslExecCustody {
  private readonly directory: string;
  private readonly runner: WslCommandRunner;
  private readonly registryProbe: WslRegistryProbe;
  private records = new Map<string, WslExecCustodyRecord>();
  private processIds = new Set<number>();
  private byteCount = 0;
  private serial: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(userDataDir: string, runner: WslCommandRunner = runWslCommand, registryProbe: WslRegistryProbe = probeRegisteredWslDistros,
    private readonly bootTime: () => Promise<number | null> = windowsBootTime) {
    this.directory = path.join(userDataDir, 'exec-spool', 'wsl-custody');
    this.runner = runner;
    this.registryProbe = registryProbe;
  }

  /** Repair orphaned pre-boot leader evidence; descendants still require the normal exact-token scan. */
  async confirmPriorBootLeaders(excluded: ReadonlySet<number>): Promise<void> {
    const candidates = this.list().filter(row => !row.leaderExited && !excluded.has(row.processId));
    if (!candidates.length) return;
    const boot = await this.bootTime().catch(() => null);
    if (boot === null || !Number.isSafeInteger(boot) || boot <= 0 || boot > Date.now()) return;
    for (const row of candidates) {
      // Leave a conservative clock boundary and recheck incarnation through markLeaderExited.
      if (row.startedAt + 60000 < boot && !excluded.has(row.processId))
        await this.markLeaderExited(row.processId, row.incarnation);
    }
  }

  private key(processId: number, incarnation: number): string { return `${processId}-${incarnation}`; }
  private file(record: Pick<WslExecCustodyRecord, 'processId' | 'incarnation'>): string {
    return path.join(this.directory, `${this.key(record.processId, record.incarnation)}.json`);
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.serial.then(fn);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const stat = await fs.lstat(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('WSL custody storage is unavailable.');
      const entries = await fs.readdir(this.directory, { withFileTypes: true });
      const rows = new Map<string, WslExecCustodyRecord>();
      const processIds = new Set<number>();
      let bytes = 0;
      for (const entry of entries) {
        if (!entry.isFile() || !/^\d{4,16}-\d{1,16}\.json$/.test(entry.name)) continue;
        const file = path.join(this.directory, entry.name), itemStat = await fs.lstat(file);
        if (!itemStat.isFile() || itemStat.isSymbolicLink()) throw new Error('WSL custody entry is not a regular file.');
        const raw = await fs.readFile(file, 'utf8');
        bytes += Buffer.byteLength(raw);
        if (bytes > MAX_REGISTRY_BYTES) throw new Error('WSL custody registry exceeds its safe size.');
        const row = validateRecord(JSON.parse(raw));
        if (`${this.key(row.processId, row.incarnation)}.json` !== entry.name || processIds.has(row.processId))
          throw new Error('WSL custody identity does not match its file or reuses a process id.');
        rows.set(this.key(row.processId, row.incarnation), row);
        processIds.add(row.processId);
      }
      this.records = rows;
      this.processIds = processIds;
      this.byteCount = bytes;
      this.initialized = true;
    });
  }

  private requireReady(): void { if (!this.initialized) throw new Error('WSL custody registry is not initialized.'); }

  async putPending(input: Omit<WslExecCustodyRecord, 'version' | 'runToken' | 'state' | 'leaderExited' | 'identities' | 'lastScanAt' | 'lastError'>): Promise<WslExecCustodyRecord> {
    this.requireReady();
    return this.enqueue(async () => {
      const key = this.key(input.processId, input.incarnation);
      if (this.records.has(key) || this.processIds.has(input.processId))
        throw new Error('WSL custody identity already exists or reuses a process id.');
      const record: WslExecCustodyRecord = { ...input, version: 1, runToken: randomBytes(32).toString('hex'),
        state: 'pending', leaderExited: false, identities: [], lastScanAt: null, lastError: null };
      const bytes = Buffer.byteLength(JSON.stringify(record));
      if (this.byteCount + bytes > MAX_REGISTRY_BYTES) throw new Error('WSL custody storage is full; no process was started.');
      await this.write(record);
      this.records.set(key, record);
      this.processIds.add(record.processId);
      this.byteCount += bytes;
      return { ...record, identities: [] };
    });
  }

  async update(record: WslExecCustodyRecord): Promise<void> {
    this.requireReady();
    await this.enqueue(async () => {
      const key = this.key(record.processId, record.incarnation);
      const previous = this.records.get(key);
      if (!previous || previous.runToken !== record.runToken)
        throw new Error('WSL custody incarnation changed.');
      // State updates can race exact request-to-session promotion. Never let a stale scan write
      // restore the temporary request principal over the newer durable owner.
      const validated = validateRecord({ ...record, ownerPrincipal: previous.ownerPrincipal });
      const oldBytes = Buffer.byteLength(JSON.stringify(previous));
      const newBytes = Buffer.byteLength(JSON.stringify(validated));
      if (this.byteCount - oldBytes + newBytes > MAX_REGISTRY_BYTES) throw new Error('WSL custody storage is full.');
      await this.write(validated);
      this.records.set(key, { ...validated, identities: [...validated.identities] });
      this.byteCount += newBytes - oldBytes;
    });
  }

  async remove(processId: number, incarnation: number): Promise<void> {
    this.requireReady();
    await this.enqueue(async () => {
      const key = this.key(processId, incarnation), previous = this.records.get(key);
      if (!previous) return;
      await fs.rm(this.file(previous), { force: true });
      this.records.delete(key);
      this.processIds.delete(processId);
      this.byteCount = Math.max(0, this.byteCount - Buffer.byteLength(JSON.stringify(previous)));
    });
  }

  async markLeaderExited(processId: number, incarnation: number): Promise<void> {
    const row = this.get(processId, incarnation);
    if (!row || row.leaderExited) return;
    await this.update({ ...row, leaderExited: true });
  }

  get(processId: number, incarnation: number): WslExecCustodyRecord | null {
    const row = this.records.get(this.key(processId, incarnation));
    return row ? { ...row, identities: [...row.identities] } : null;
  }
  list(): WslExecCustodyRecord[] { return [...this.records.values()].map(row => ({ ...row, identities: [...row.identities] })); }

  async promote(processId: number, incarnation: number, from: string, to: string): Promise<void> {
    this.requireReady();
    await this.enqueue(async () => {
      const key = this.key(processId, incarnation), previous = this.records.get(key);
      if (!previous || previous.ownerPrincipal !== from) return;
      const promoted = { ...previous, ownerPrincipal: to };
      const oldBytes = Buffer.byteLength(JSON.stringify(previous)), newBytes = Buffer.byteLength(JSON.stringify(promoted));
      await this.write(promoted);
      this.records.set(key, promoted);
      this.byteCount += newBytes - oldBytes;
    });
  }

  async scan(record: WslExecCustodyRecord): Promise<{ complete: boolean; identities: WslProcessIdentity[]; error: string | null }> {
    const identities: WslProcessIdentity[] = [];
    const errors: string[] = [];
    try {
      const listed = await this.runner(['--list', '--running', '--quiet'], COMMAND_TIMEOUT_MS);
      if (listed.error) {
        if (record.leaderExited && (listed.error as NodeJS.ErrnoException).code === 'ENOENT')
          return { complete: true, identities: [], error: null };
        throw new Error('Could not list running WSL distributions.');
      }
      if (listed.code !== 0) {
        const registration = record.leaderExited ? await this.registryProbe() : 'unknown';
        if (registration === 'empty') return { complete: true, identities: [], error: null };
        throw new Error(registration === 'present' ? 'WSL reports registered distributions but could not list running distributions.'
          : 'Could not list running WSL distributions or prove that none are registered.');
      }
      const distros = decodeWslOutput(listed.stdout).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      if (distros.length > MAX_DISTROS) throw new Error('Too many running WSL distributions to scan safely.');
      if (distros.some(distro => distro.length > 256 || /[\0\r]/.test(distro))) throw new Error('WSL returned an invalid distribution name.');
      for (const distro of distros) {
        const result = await this.runner(['--distribution', distro, '--user', 'root', '--exec', 'sh', '-c', SCAN_SCRIPT, 'onecode-wsl-scan', record.runToken], COMMAND_TIMEOUT_MS);
        if (result.error || result.code !== 0) { errors.push(`Could not completely scan WSL distribution ${distro}.`); continue; }
        const text = decodeWslOutput(result.stdout);
        const done = /^DONE ([02])\s*$/m.exec(text);
        if (!done) { errors.push(`WSL process scan was incomplete in ${distro}.`); continue; }
        for (const line of text.split(/\r?\n/)) {
          const match = /^MATCH (\d+) (\d+)$/.exec(line);
          if (match) identities.push({ distro, pid: Number(match[1]), startTime: match[2]! });
        }
        if (done[1] === '2') errors.push(`WSL process scan was incomplete in ${distro}.`);
      }
      if (distros.length === 0) {
        return record.leaderExited ? { complete: true, identities: [], error: null }
          : { complete: false, identities: [], error: 'No running WSL distributions are visible while the Windows command leader is still active.' };
      }
      return { complete: errors.length === 0, identities, error: errors.join(' ') || null };
    } catch (error) {
      return { complete: false, identities, error: error instanceof Error ? error.message : 'WSL process scan failed.' };
    }
  }

  /** Add this run's token to the Windows child environment and WSLENV direction flags. */
  environmentFor(record: WslExecCustodyRecord, original: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...original, [TOKEN_NAME]: record.runToken };
    for (const keyName of Object.keys(env)) if (keyName.toUpperCase() === 'WSLENV') delete env[keyName];
    const originalWslEnv = Object.entries(original).find(([name]) => name.toUpperCase() === 'WSLENV')?.[1] ?? '';
    const entries = originalWslEnv.split(':').filter(Boolean);
    const key = (entry: string): string => entry.split('/')[0]!.toUpperCase();
    const preserved = entries.filter(entry => key(entry) !== TOKEN_NAME);
    preserved.push(`${TOKEN_NAME}/u`);
    env.WSLENV = preserved.join(':');
    return env;
  }

  async terminate(record: WslExecCustodyRecord): Promise<{ complete: boolean; remaining: WslProcessIdentity[]; error: string | null }> {
    let current = this.get(record.processId, record.incarnation);
    if (!current || current.runToken !== record.runToken) return { complete: false, remaining: [], error: 'WSL custody identity is stale.' };
    let scan = await this.scan(current);
    current = { ...current, state: scan.complete && scan.identities.length === 0 ? 'tagged' : 'termination-unknown', identities: scan.identities,
      lastScanAt: Date.now(), lastError: scan.error };
    await this.update(current);
    if (!scan.complete && scan.identities.length === 0) return { complete: false, remaining: current.identities, error: scan.error };
    if (scan.complete && scan.identities.length === 0 && !current.leaderExited) {
      current = { ...current, state: 'termination-unknown', lastScanAt: Date.now(),
        lastError: 'No tagged WSL processes are visible, but the Windows leader exit is not confirmed.' };
      await this.update(current);
      return { complete: false, remaining: [], error: current.lastError };
    }
    for (const identity of scan.identities) {
      const signal = async (name: 'TERM' | 'KILL'): Promise<void> => {
        const result = await this.runner(['--distribution', identity.distro, '--user', 'root', '--exec', 'sh', '-c', SIGNAL_SCRIPT,
          'onecode-wsl-signal', current!.runToken, String(identity.pid), identity.startTime, name], COMMAND_TIMEOUT_MS);
        // 23/24 mean /proc no longer contains this exact start identity (or its PID was reused).
        // Never signal the replacement; a later full token scan decides whether the run remains.
        if (result.code === 23 || result.code === 24) return;
        if (result.error || result.code !== 0) throw new Error(`Could not verify or signal tagged WSL process ${identity.pid} in ${identity.distro}.`);
      };
      try { await signal('TERM'); } catch (error) {
        current = { ...current, state: 'termination-unknown', lastError: error instanceof Error ? error.message : 'WSL termination failed.' };
        await this.update(current);
        return { complete: false, remaining: current.identities, error: current.lastError };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 400));
    scan = await this.scan(current);
    if (!scan.complete && scan.identities.length === 0) {
      current = { ...current, state: 'termination-unknown', lastScanAt: Date.now(), lastError: scan.error };
      await this.update(current);
      return { complete: false, remaining: current.identities, error: scan.error };
    }
    for (const identity of scan.identities) {
      const result = await this.runner(['--distribution', identity.distro, '--user', 'root', '--exec', 'sh', '-c', SIGNAL_SCRIPT,
        'onecode-wsl-signal', current.runToken, String(identity.pid), identity.startTime, 'KILL'], COMMAND_TIMEOUT_MS);
      if (result.code === 23 || result.code === 24) continue;
      if (result.error || result.code !== 0) {
        current = { ...current, state: 'termination-unknown', identities: scan.identities, lastScanAt: Date.now(), lastError: 'Could not verify or force-stop a tagged WSL process.' };
        await this.update(current);
        return { complete: false, remaining: scan.identities, error: current.lastError };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    scan = await this.scan(current);
    current = { ...current, state: scan.complete && scan.identities.length === 0 ? 'tagged' : 'termination-unknown', identities: scan.identities,
      lastScanAt: Date.now(), lastError: scan.error };
    if (!scan.complete || scan.identities.length) {
      await this.update(current);
      return { complete: false, remaining: scan.identities, error: scan.error ?? 'Tagged WSL processes remain after termination.' };
    }
    if (!current.leaderExited) {
      current = { ...current, state: 'termination-unknown', lastError: 'Tagged WSL processes were signalled, but the Windows leader exit is not confirmed.' };
      await this.update(current);
      return { complete: false, remaining: [], error: current.lastError };
    }
    await this.remove(current.processId, current.incarnation);
    return { complete: true, remaining: [], error: null };
  }

  private async write(record: WslExecCustodyRecord): Promise<void> {
    const file = this.file(record), temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    try {
      await fs.rename(temp, file);
      if (process.platform !== 'win32') {
        const directory = await fs.open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    }
    catch (error) { await fs.rm(temp, { force: true }).catch(() => undefined); throw error; }
  }
}
