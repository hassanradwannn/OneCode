/**
 * Codex "unified exec": the runtime behind `exec_command` and `write_stdin`.
 *
 * Ported from `codex-rs/core/src/unified_exec/` — `mod.rs`, `process.rs`, `process_manager.rs`
 * and `errors.rs` — together with `ExecCommandToolOutput` from `codex-rs/core/src/tools/context.rs`.
 *
 * Nothing here shells out to Codex or depends on a Codex install. The Rust tokio machinery
 * (`Notify`, `CancellationToken`, `watch`, an interaction `Mutex`) is reproduced with the
 * JavaScript equivalents so the observable semantics survive: one shared output buffer that
 * a poll *drains*, a head/tail cap on what is retained, a yield deadline with a short
 * post-exit grace, and a session that outlives the call that created it.
 *
 * Two Windows adaptations, both about launching rather than about behaviour:
 *   - `cmd.exe` gets a verbatim command line. Node (like Rust) would otherwise escape inner
 *     quotes as `\"`, which cmd has never understood, and cmd exits 0 after failing to run
 *     it — a command that silently does nothing.
 *   - `interrupt()` terminates Windows pipe process trees; POSIX uses group SIGINT. A Windows console
 *     control event cannot be delivered to a child that owns no console.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { HeadTailBuffer } from './head-tail-buffer.js';
import { CommandBatchDisplay } from './command-batch.js';
import {
  approxTokenCount,
  approxTokensFromByteCount,
  byteLength,
  formattedTruncateText,
  policyTokenBudget,
  truncateText,
  type TruncationPolicy
} from './truncate.js';
import {
  clampYieldTime,
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  formatOutputOmissionMarker,
  generateChunkId,
  INTERRUPT,
  MAX_UNIFIED_EXEC_PROCESSES,
  MAX_YIELD_TIME_MS,
  MIN_EMPTY_YIELD_TIME_MS,
  MIN_YIELD_TIME_MS,
  resolveMaxTokens,
  UNIFIED_EXEC_ENV
} from './unified-exec-constants.js';
import { terminateProcessTree } from '../exec.js';
import { prefixPowershellScriptWithUtf8, type ShellType } from './shell.js';
import { FileExecSpool, MemoryExecSpool, type CompletedExecSpoolRecord, type ExecSpool, type LiveExecSpoolRecord } from './unified-exec-spool.js';
import type { ChatProvider } from '../../shared/chat-provider.js';

// --------------------------------------------------------------------------- errors

export type UnifiedExecErrorKind =
  | 'create_process'
  | 'terminal_capacity'
  | 'terminal_storage_unavailable'
  | 'process_failed'
  | 'unknown_process_id'
  | 'write_to_stdin'
  | 'stdin_closed'
  | 'missing_command_line';

/**
 * `UnifiedExecError`, with both of the Rust renderings it is shown through.
 *
 * `message` is the `Display` form, which is what `write_stdin failed: {err}` prints; `debug()`
 * is the derived `Debug` form, which is what `exec_command failed for ...: {err:?}` prints.
 * They differ, and both reach the model, so both are reproduced.
 */
export class UnifiedExecError extends Error {
  readonly kind: UnifiedExecErrorKind;
  readonly processId: number | null;
  readonly detail: string | null;

  private constructor(kind: UnifiedExecErrorKind, message: string, detail: string | null, processId: number | null) {
    super(message);
    this.name = 'UnifiedExecError';
    this.kind = kind;
    this.detail = detail;
    this.processId = processId;
  }

  static createProcess(message: string): UnifiedExecError {
    return new UnifiedExecError('create_process', `Failed to create unified exec process: ${message}`, message, null);
  }

  static terminalCapacity(message: string): UnifiedExecError {
    return new UnifiedExecError('terminal_capacity', `TERMINAL_CAPACITY: ${message}`, message, null);
  }

  static terminalStorageUnavailable(): UnifiedExecError {
    return new UnifiedExecError('terminal_storage_unavailable',
      'TERMINAL_STORAGE_UNAVAILABLE: durable terminal result storage is not ready; no command was started.',
      'durable terminal result storage is not ready; no command was started', null);
  }

  static processFailed(message: string): UnifiedExecError {
    return new UnifiedExecError('process_failed', `Unified exec process failed: ${message}`, message, null);
  }

  static unknownProcessId(processId: number): UnifiedExecError {
    return new UnifiedExecError('unknown_process_id', `Unknown process id ${processId}`, null, processId);
  }

  static writeToStdin(): UnifiedExecError {
    return new UnifiedExecError('write_to_stdin', 'failed to write to stdin', null, null);
  }

  static stdinClosed(): UnifiedExecError {
    return new UnifiedExecError(
      'stdin_closed',
      'stdin is closed for this session; rerun exec_command with tty=true to keep stdin open',
      null,
      null
    );
  }

  static missingCommandLine(): UnifiedExecError {
    return new UnifiedExecError('missing_command_line', 'missing command line for unified exec request', null, null);
  }

  /** The `{err:?}` rendering of the Rust enum. */
  debug(): string {
    switch (this.kind) {
      case 'create_process':
        return `CreateProcess { message: ${JSON.stringify(this.detail ?? '')} }`;
      case 'terminal_capacity':
        return `TERMINAL_CAPACITY { message: ${JSON.stringify(this.detail ?? '')} }`;
      case 'terminal_storage_unavailable':
        return `TERMINAL_STORAGE_UNAVAILABLE { message: ${JSON.stringify(this.detail ?? '')} }`;
      case 'process_failed':
        return `ProcessFailed { message: ${JSON.stringify(this.detail ?? '')} }`;
      case 'unknown_process_id':
        return `UnknownProcessId { process_id: ${this.processId ?? 0} }`;
      case 'write_to_stdin':
        return 'WriteToStdin';
      case 'stdin_closed':
        return 'StdinClosed';
      case 'missing_command_line':
        return 'MissingCommandLine';
    }
  }
}

// --------------------------------------------------------------------------- notify

/** `tokio::sync::Notify`, minus the stored permit: waiters registered before the notify. */
class Notify {
  private waiters = new Set<() => void>();

  /** A one-shot wait that must be disposed, so a lost race does not leak its resolver. */
  notified(): { promise: Promise<void>; dispose: () => void } {
    let resolver: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolver = resolve;
      this.waiters.add(resolver);
    });
    return { promise, dispose: () => this.waiters.delete(resolver) };
  }

  notifyWaiters(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) resolve();
  }
}

/** An async mutex standing in for the per-process `interaction_lock`. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private locked = false;
  private queued = 0;

  async lock(): Promise<() => void> {
    // Count the request before the first await. A holder releases synchronously, while the next
    // queued lock only resumes in a microtask; without this bit of state tryLock() can barge into
    // that handoff gap even though a waiter is already entitled to the lock.
    this.queued += 1;
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = () => {
        this.locked = false;
        resolve();
      };
    });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    this.queued -= 1;
    this.locked = true;
    return release;
  }

  /** `try_lock_owned`: null when someone else holds it, so pruning can skip busy sessions. */
  tryLock(): (() => void) | null {
    if (this.locked || this.queued > 0) return null;
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = () => {
        this.locked = false;
        resolve();
      };
    });
    this.tail = this.tail.then(() => next);
    this.locked = true;
    return release;
  }
}

// --------------------------------------------------------------------------- pty loading

/** The slice of node-pty this module uses, declared locally so an absent module is not a build edge. */
interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: readonly string[] | string,
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
  ): PtyProcess;
}

let ptyModule: Promise<PtyModule | null> | null = null;

async function loadPty(): Promise<PtyModule | null> {
  ptyModule ??= import('node-pty')
    .then((module) => ((module as { default?: PtyModule }).default ?? module) as PtyModule)
    .catch(() => null);
  return ptyModule;
}

// --------------------------------------------------------------------------- process

export interface SpawnParams {
  batchMarker?: string;
  /** The derived argv; element 0 is the executable. */
  command: string[];
  shellType: ShellType;
  cwd: string;
  env: NodeJS.ProcessEnv;
  tty: boolean;
  onOutputCheckpoint?: () => void;
}

const EARLY_EXIT_GRACE_PERIOD_MS = 150;
const POST_EXIT_CLOSE_WAIT_CAP_MS = 50;
export const MAX_COMPLETED_EXEC_RESULTS = 64;
export const COMPLETED_EXEC_OUTPUT_BYTES = 256 * 1024;

/** Applies `UNIFIED_EXEC_ENV` over the caller's environment, as `apply_unified_exec_env`. */
export function applyUnifiedExecEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of UNIFIED_EXEC_ENV) result[key] = value;
  return result;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}

/** MSVCRT-style quoting for one argument, for the verbatim `cmd.exe` command line only. */
function quoteWindowsArgument(argument: string): string {
  if (argument !== '' && !/[\s"]/.test(argument)) return argument;
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}

/**
 * One running unified exec session.
 *
 * The output buffer is *drained* by whoever polls it, which is the property the whole design
 * rests on: a chunk is delivered to exactly one call, so two consecutive `write_stdin` polls
 * see new bytes while work runs. Once completed delivery is acknowledged, the manager's
 * bounded history permits explicitly labeled rereads without executing the command again.
 */
class UnifiedExecProcess {
  readonly identity = {};
  private readonly startedAt = Date.now();
  private resolveCompletion!: (value: ProcessCompletion) => void;
  readonly completion = new Promise<ProcessCompletion>(resolve => { this.resolveCompletion = resolve; });
  private buffer = new HeadTailBuffer();
  private readonly history = new HeadTailBuffer(COMPLETED_EXEC_OUTPUT_BYTES);
  private readonly displayHistory = new HeadTailBuffer(COMPLETED_EXEC_OUTPUT_BYTES);
  private displayBuffer: HeadTailBuffer | undefined;
  private readonly batchDisplay: CommandBatchDisplay | undefined;
  readonly outputNotify = new Notify();
  readonly outputClosedNotify = new Notify();
  readonly cancelNotify = new Notify();
  readonly interactionLock = new Mutex();
  outputClosed = false;
  outputInterrupted = false;
  cancelled = false;
  private outputSealed = false;
  private exited = false;
  private exit: number | null = null;
  private failure: string | null = null;
  private openStreams = 0;
  private child: ChildProcess | null = null;
  private pty: PtyProcess | null = null;
  readonly tty: boolean;
  private readonly spawnPid: number;
  private readonly onOutputCheckpoint?: () => void;

  private constructor(tty: boolean, pid: number, batchMarker?: string, onOutputCheckpoint?: () => void) {
    this.tty = tty;
    this.spawnPid = pid;
    this.onOutputCheckpoint = onOutputCheckpoint;
    if (batchMarker) {
      this.batchDisplay = new CommandBatchDisplay(batchMarker);
      this.displayBuffer = new HeadTailBuffer();
    }
  }

  /**
   * The session leader's OS pid, read through to the live handle rather than snapshotted.
   *
   * node-pty's Windows ConPTY backend connects asynchronously: `pty.spawn()` hands back a
   * handle whose `pid` is still 0, and it is filled in later, when the conout pipe reports
   * `ready_datapipe` — comfortably after `EARLY_EXIT_GRACE_PERIOD_MS`. Recording it at
   * construction therefore stored 0 for every Windows tty session for the session's whole
   * life. That made `list_processes` advertise a pid nobody can act on, and, worse, made
   * `terminate()` fail its own `pid > 0` test and skip `terminateProcessTree` entirely — so
   * whenever node-pty had deferred its internal `kill()` (it queues the call until the pty is
   * ready), nothing ever killed the shell, and its console host outlived the app. Every
   * consumer reads this well after connect, so reading through is both correct and enough.
   */
  get pid(): number {
    const live = this.pty?.pid ?? 0;
    return live > 0 ? live : this.spawnPid;
  }

  static async spawn(params: SpawnParams): Promise<UnifiedExecProcess> {
    const file = params.command[0];
    if (file === undefined || params.command.length === 0) throw UnifiedExecError.missingCommandLine();
    const args = params.command.slice(1);

    if (params.tty) {
      const pty = await loadPty();
      if (!pty) {
        throw UnifiedExecError.createProcess('a pseudo-console is not available on this machine');
      }
      let handle: PtyProcess;
      try {
        handle = pty.spawn(
          file,
          // cmd.exe needs the command line it will actually parse; everything else is
          // quoted by node-pty from the argument list.
          params.shellType === 'cmd' && process.platform === 'win32'
            ? [quoteWindowsArgument(file), ...args].join(' ')
            : args,
          {
            name: 'dumb',
            cols: DEFAULT_TERMINAL_COLS,
            rows: DEFAULT_TERMINAL_ROWS,
            cwd: params.cwd,
            env: stringEnv(params.env)
          }
        );
      } catch (error) {
        throw UnifiedExecError.createProcess(error instanceof Error ? error.message : String(error));
      }
      const managed = new UnifiedExecProcess(true, handle.pid, params.batchMarker, params.onOutputCheckpoint);
      managed.pty = handle;
      handle.onData((data) => managed.pushChunk(Buffer.from(data, 'utf8')));
      handle.onExit((event) => {
        managed.signalExit(event.exitCode);
        managed.closeOutput();
      });
      await managed.waitForEarlyExit();
      return managed;
    }

    let child: ChildProcess;
    try {
      const verbatim = params.shellType === 'cmd' && process.platform === 'win32';
      child = spawn(file, args, {
        cwd: params.cwd,
        env: params.env,
        windowsHide: true,
        shell: false,
        // Codex sessions must own descendants as well as the shell process. On POSIX a
        // detached child is a process-group leader, which lets interrupt/terminate signal
        // the whole session without changing Windows' existing taskkill semantics.
        detached: process.platform !== 'win32',
        // `stdin_open: tty` in Codex: a pipe session has no stdin, which is what makes
        // write_stdin answer StdinClosed rather than pretending the write landed.
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(verbatim ? { windowsVerbatimArguments: true } : {})
      });
    } catch (error) {
      throw UnifiedExecError.createProcess(error instanceof Error ? error.message : String(error));
    }

    const managed = new UnifiedExecProcess(false, child.pid ?? -1, params.batchMarker, params.onOutputCheckpoint);
    managed.child = child;
    // stdout and stderr are combined into one stream, exactly as `combine_output_receivers`
    // does on the local Codex path, so interleaving is preserved in arrival order.
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      managed.openStreams += 1;
      stream.on('data', (chunk: Buffer) => managed.pushChunk(chunk));
      stream.on('end', () => managed.streamEnded());
      stream.on('error', () => managed.streamEnded());
    }
    if (managed.openStreams === 0) managed.closeOutput();

    const spawnFailure = new Promise<void>((resolve) => {
      child.once('error', (error: Error) => {
        managed.failure = error.message;
        managed.signalExit(null);
        managed.closeOutput();
        resolve();
      });
    });
    void spawnFailure;
    child.once('exit', (code, signal) => {
      managed.signalExit(code === null && signal ? null : code);
    });

    await managed.waitForEarlyExit();
    // Node reports an OS-level spawn failure (for example ENOENT for a missing
    // executable) through the ChildProcess `error` event instead of throwing
    // from spawn(). Codex's spawn_process returns that same failure from the
    // creation boundary, so it is a CreateProcess error rather than a later
    // ProcessFailed error. The event necessarily arrives before a successful
    // `spawn` event, well inside Codex's 150 ms early-exit grace window.
    if (managed.failure !== null && child.pid === undefined) {
      throw UnifiedExecError.createProcess(managed.failure);
    }
    return managed;
  }

  /** `EARLY_EXIT_GRACE_PERIOD`: a command that is already over must not be stored as live. */
  private async waitForEarlyExit(): Promise<void> {
    if (this.cancelled) return;
    const wait = this.cancelNotify.notified();
    try {
      await Promise.race([wait.promise, sleep(EARLY_EXIT_GRACE_PERIOD_MS)]);
    } finally {
      wait.dispose();
    }
  }

  private pushChunk(chunk: Buffer): void {
    if (chunk.length === 0 || this.outputSealed) return;
    this.history.pushChunk(chunk);
    this.buffer.pushChunk(chunk);
    const displayChunk = this.batchDisplay ? this.batchDisplay.push(chunk) : chunk;
    this.displayHistory.pushChunk(displayChunk);
    if (this.batchDisplay) this.displayBuffer!.pushChunk(displayChunk);
    this.outputNotify.notifyWaiters();
    this.onOutputCheckpoint?.();
  }

  private streamEnded(): void {
    this.openStreams -= 1;
    if (this.openStreams <= 0) this.closeOutput();
  }

  private closeOutput(): void {
    if (this.outputClosed || this.outputInterrupted) return;
    if (this.batchDisplay) {
      const finalChunk = this.batchDisplay.push(Buffer.alloc(0), true);
      this.displayHistory.pushChunk(finalChunk);
      this.displayBuffer!.pushChunk(finalChunk);
    }
    this.outputSealed = true;
    this.outputClosed = true;
    this.outputClosedNotify.notifyWaiters();
  }

  private sealInterruptedOutput(): void {
    if (this.outputClosed || this.outputInterrupted) return;
    if (this.batchDisplay) {
      const finalChunk = this.batchDisplay.push(Buffer.alloc(0), true);
      this.displayHistory.pushChunk(finalChunk);
      this.displayBuffer!.pushChunk(finalChunk);
    }
    this.outputSealed = true;
    this.outputInterrupted = true;
    this.outputNotify.notifyWaiters();
    this.outputClosedNotify.notifyWaiters();
  }

  async waitForOutputClosed(timeoutMs = Number.POSITIVE_INFINITY): Promise<boolean> {
    const deadline = Number.isFinite(timeoutMs) ? Date.now() + Math.max(0, timeoutMs) : Number.POSITIVE_INFINITY;
    while (!this.outputClosed && !this.outputInterrupted) {
      const closed = this.outputClosedNotify.notified();
      if (this.outputClosed || this.outputInterrupted) { closed.dispose(); break; }
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        if (await raceWithTimeout([closed], remaining)) return false;
      } finally { closed.dispose(); }
    }
    return this.outputClosed;
  }

  private signalExit(exitCode: number | null): void {
    if (!this.exited) {
      this.exited = true;
      this.exit = exitCode;
      const completedAt = Date.now();
      this.resolveCompletion({ exitCode, completedAt, durationMs: Math.max(0, completedAt - this.startedAt) });
    }
    if (!this.cancelled) {
      this.cancelled = true;
      this.cancelNotify.notifyWaiters();
    }
  }

  /** `std::mem::take` of the shared buffer. */
  takeBuffer(): { raw: HeadTailBuffer; display?: HeadTailBuffer } {
    const drained = { raw: this.buffer, display: this.displayBuffer };
    this.buffer = new HeadTailBuffer();
    if (this.displayBuffer) this.displayBuffer = new HeadTailBuffer();
    return drained;
  }

  /** Completed output is immutable once both exit and stream closure are observed. */
  completedOutput(): Buffer | null {
    return this.hasExited() && (this.outputClosed || this.outputInterrupted)
      ? (this.batchDisplay ? this.displayHistory : this.history).toBytesWithOmissionMarker() : null;
  }

  /** Independent of the unread cursor: explicit rereads include earlier delivered chunks. */
  retainedOutput(): Buffer {
    return this.history.toBytesWithOmissionMarker();
  }

  retainedDisplayOutput(): Buffer {
    return (this.batchDisplay ? this.displayHistory : this.history).toBytesWithOmissionMarker();
  }

  rawOmittedBytes(): number { return this.history.omittedBytes(); }
  displayOmittedBytes(): number { return (this.batchDisplay ? this.displayHistory : this.history).omittedBytes(); }

  benignExit(classify: ExecCommandRequest['classifyExit']): boolean {
    // An omitted diagnostic or still-open stream cannot prove a non-zero result benign.
    return this.hasExited() && this.outputClosed && this.history.omittedBytes() === 0 &&
      (classify?.(this.exitCode(), this.retainedOutput().toString('utf8')) ?? false);
  }

  hasExited(): boolean {
    return this.exited;
  }

  exitCode(): number | null {
    return this.exit;
  }

  failureMessage(): string | null {
    return this.failure;
  }

  async write(data: string): Promise<void> {
    if (this.pty) {
      try {
        this.pty.write(data);
        return;
      } catch {
        throw UnifiedExecError.writeToStdin();
      }
    }
    // A pipe session was spawned without stdin, so there is nothing to write to. Codex
    // reaches the same answer through `StdinClosed` before ever calling write.
    throw UnifiedExecError.writeToStdin();
  }

  async interrupt(): Promise<void> {
    if (this.pty) {
      try {
        this.pty.write(INTERRUPT);
        return;
      } catch (error) {
        throw UnifiedExecError.processFailed(error instanceof Error ? error.message : String(error));
      }
    }
    const pid = this.child?.pid;
    if (pid === undefined) throw UnifiedExecError.processFailed('the process is no longer running');
    try {
      // Windows pipe children have no console for Ctrl-C. Terminate the tree before
      // its leader disappears, otherwise descendants retain the session's pipes/cwd.
      if (process.platform === 'win32') await terminateProcessTree(pid, true);
      else process.kill(-pid, 'SIGINT');
    } catch (error) {
      // The managed session can outlive the OS process for the tiny window before Node's
      // ChildProcess `exit` event reaches us. Ctrl+C in that window used to turn a successful
      // natural exit into `kill ESRCH`, while the next empty poll immediately returned DONE.
      // "Already gone" is exactly the terminal state the interrupt was trying to reach.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw UnifiedExecError.processFailed(error instanceof Error ? error.message : String(error));
    }
  }

  async terminate(): Promise<void> {
    if (this.pty) {
      try {
        this.pty.kill();
      } catch {
        /* already gone */
      }
      // node-pty queues `kill()` until the pty reports ready and drops it silently if that
      // never happens, so the process tree is the authority here, not the handle. `pid` is a
      // live read for exactly this reason.
      if (this.pid > 0) await terminateProcessTree(this.pid, true);
    } else if (this.child?.pid !== undefined) {
      await terminateProcessTree(this.child.pid, true);
    }
    this.signalExit(this.exit);
    if (!this.outputClosed && !(await this.waitForOutputClosed(POST_EXIT_CLOSE_WAIT_CAP_MS))) {
      // The leader may be gone while a descendant keeps inherited streams open. Freeze only
      // bytes already received and report that the captured output ended under the close cap.
      this.sealInterruptedOutput();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    if (typeof timer.unref === 'function') timer.unref();
  });
}

// --------------------------------------------------------------------------- tool output

export interface ProcessCompletion {
  benignExit?: boolean;
  outputInterrupted?: boolean;
  exitCode: number | null;
  completedAt: number;
  durationMs: number;
}

export interface ExecCommandToolOutput {
  completedSessionId?: number;
  replayed?: boolean;
  terminalStoragePending?: boolean;
  terminalOutputInterrupted?: boolean;
  terminalOutputCheckpointed?: boolean;
  benignExit?: boolean;
  /** Exact process lifetime for recording; never serialized into the MCP response. */
  completion?: Promise<ProcessCompletion>;
  chunkId: string;
  wallTimeMs: number;
  rawOutput: Buffer;
  /** Batches alone retain a separately bounded, delimiter-free presentation stream. */
  displayOutput?: Buffer;
  truncationPolicy: TruncationPolicy;
  maxOutputTokens: number | undefined;
  /** The session id, present only while the process is still running. */
  processId: number | null;
  exitCode: number | null;
  originalTokenCount: number | null;
  /** Bytes the 1 MiB collection cap dropped, before model-facing truncation. */
  outputOmittedBytes: number | null;
}

function modelOutputMaxTokens(output: ExecCommandToolOutput): number {
  return Math.min(resolveMaxTokens(output.maxOutputTokens), policyTokenBudget(output.truncationPolicy));
}

/** `ExecCommandToolOutput::truncated_output`. */
export function truncatedOutput(output: ExecCommandToolOutput, maxTokens: number): string {
  const text = (output.displayOutput ?? output.rawOutput).toString('utf8');
  const policy: TruncationPolicy = { kind: 'tokens', tokens: maxTokens };
  if (output.outputOmittedBytes === null || output.outputOmittedBytes === 0) {
    return formattedTruncateText(text, policy);
  }

  const marker = formatOutputOmissionMarker(output.outputOmittedBytes);
  if (byteLength(text) <= maxTokens * 4) {
    return text.includes(marker) ? text : `${marker}\n${text}`;
  }

  const originalTokenCount = output.originalTokenCount ?? approxTokenCount(text);
  const truncated = truncateText(text, policy);
  const omissionNotice = truncated.includes(marker) ? '' : `${marker}\n`;
  return `Warning: truncated output (original token count: ${originalTokenCount})\n${omissionNotice}\n${truncated}`;
}

/** `ExecCommandToolOutput::response_text` — exactly what the model is handed. */
export function execCommandResponseText(output: ExecCommandToolOutput): string {
  const sections: string[] = [];
  if (output.chunkId !== '') sections.push(`Chunk ID: ${output.chunkId}`);
  sections.push(`Wall time: ${(output.wallTimeMs / 1000).toFixed(4)} seconds`);
  if (output.exitCode !== null) sections.push(`Process exited with code ${output.exitCode}`);
  if (output.processId !== null) sections.push(`Process running with session ID ${output.processId}`);
  if (output.completedSessionId !== undefined) sections.push(`Completed session ID: ${output.completedSessionId}`);
  if (output.replayed) sections.push('Retained output (already completed; command was not run again):');
  if (output.terminalStoragePending) sections.push('Warning: completed terminal output is still held in memory because durable storage failed. No command was rerun; retry this session read after storage is available.');
  if (output.terminalOutputInterrupted) sections.push('Warning: output streams stayed open past the close-wait limit. Captured bytes are retained, but the output is incomplete.');
  if (output.terminalOutputCheckpointed) sections.push('Warning: OneCode restarted while this command was live. Only the last durable output checkpoint is retained; later output is unknown, and the command was not restarted.');
  if (output.benignExit) sections.push('This non-zero exit is an expected command result, not a failure.');
  if (output.originalTokenCount !== null) sections.push(`Original token count: ${output.originalTokenCount}`);
  sections.push('Output:');
  sections.push(truncatedOutput(output, modelOutputMaxTokens(output)));
  return sections.join('\n');
}

/** `ExecCommandToolOutput::code_mode_result`, which is also the tool's declared output schema. */
export function execCommandStructuredOutput(output: ExecCommandToolOutput): Record<string, unknown> {
  return {
    ...(output.chunkId === '' ? {} : { chunk_id: output.chunkId }),
    wall_time_seconds: output.wallTimeMs / 1000,
    ...(output.exitCode === null ? {} : { exit_code: output.exitCode }),
    ...(output.processId === null ? {} : { session_id: output.processId }),
    ...(output.completedSessionId === undefined ? {} : { completed_session_id: output.completedSessionId }),
    // Named for what it says (#1417): "benign" read to Gemini's reviewer as a verdict on risk.
    ...(output.benignExit ? { expected_exit: true } : {}),
    ...(output.replayed ? { output_replayed: true } : {}),
    ...(output.terminalStoragePending ? { terminal_storage_pending: true } : {}),
    ...(output.terminalOutputInterrupted ? { terminal_output_interrupted: true } : {}),
    ...(output.terminalOutputCheckpointed ? { terminal_output_checkpointed: true } : {}),
    ...(output.originalTokenCount === null ? {} : { original_token_count: output.originalTokenCount }),
    // This adapter emits structuredContent beside the text result, so both representations
    // must obey the same policy/default budget. Returning the retained raw buffer here made
    // the schema path bypass the model-visible truncation entirely.
    output: truncatedOutput(output, modelOutputMaxTokens(output))
  };
}

// --------------------------------------------------------------------------- manager

export interface ExecCommandRequest {
  classifyExit?: (exitCode: number | null, rawOutput: string) => boolean;
  batchMarker?: string;
  command: string[];
  shellType: ShellType;
  hookCommand: string;
  processId: number;
  yieldTimeMs: number;
  maxOutputTokens: number | undefined;
  truncationPolicy: TruncationPolicy;
  cwd: string;
  /** The virtual path this ran in, kept only so `session status` can name it. */
  displayCwd: string;
  env: NodeJS.ProcessEnv;
  tty: boolean;
  /** Exact owner captured at admission; null remains quarantined anonymous custody. */
  ownerPrincipal?: string | null;
  provider?: ChatProvider;
  requestId?: string | null;
  sessionId?: string | null;
  conversationId?: string | null;
  setupProfileId?: string | null;
}

export interface WriteStdinRequest {
  processId: number;
  input: string;
  yieldTimeMs: number;
  maxOutputTokens: number | undefined;
  truncationPolicy: TruncationPolicy;
  maxWriteStdinYieldTimeMs?: number;
}

export interface BackgroundTerminalInfo {
  processId: number;
  incarnation: number;
  command: string;
  cwd: string;
  pid: number;
  tty: boolean;
  startedAt: number;
}

interface ProcessEntry {
  classifyExit?: ExecCommandRequest['classifyExit'];
  batchMarker?: string;
  process: UnifiedExecProcess;
  processId: number;
  incarnation: number;
  cwd: string;
  hookCommand: string;
  tty: boolean;
  startedAt: number;
  ownerPrincipal: string | null;
  provider?: ChatProvider;
  requestId?: string | null;
  sessionId?: string | null;
  conversationId?: string | null;
  setupProfileId?: string | null;
  initialExecCommandActive: boolean;
  initialOutputOffset?: number;
  /** Cursor into this process's own completed buffer; offers never consume bytes. */
  delivery?: { offset: number; offer?: { end: number; publication: OutputPublication } };
}

/** Local response completion, not a claim that a remote model understood the output. */
export interface OutputPublication {
  completedAt: number | null;
  failed: boolean;
}

export interface CompletedOutputPage {
  processId: number;
  command: string;
  exitCode: number | null;
  output: string;
  start: number;
  end: number;
  total: number;
  outputInterrupted: boolean;
  outputCaptureIncomplete: boolean;
}

export interface BackgroundExecState {
  running: number[];
  exitedUnread: Array<{ processId: number; exitCode: number | null }>;
}

export class UnifiedExecProcessManager {
  private readonly processes = new Map<number, ProcessEntry>();
  private readonly completed = new Map<number, Pick<ExecCommandToolOutput, 'rawOutput' | 'displayOutput' | 'exitCode' | 'benignExit'> & { identity: object }>();
  private releaseListener?: (processId: number) => void;
  private spoolRestoreListener?: (records: CompletedExecSpoolRecord[]) => void;
  private processChangeListener?: () => void;
  private readonly reservedProcessIds = new Set<number>();
  private spool: ExecSpool = new MemoryExecSpool();
  private readonly spooled = new Map<number, CompletedExecSpoolRecord>();
  private readonly spoolOffers = new Map<number, { end: number; publication: OutputPublication }>();
  private readonly spoolFailures = new Set<number>();
  private spoolInitialized = false;
  private spoolInitializationError: string | null = null;
  private spoolUserDataDir: string | null = null;
  private spoolInitFlight: Promise<CompletedExecSpoolRecord[]> | null = null;
  private lastSpoolInitAttemptAt = 0;
  private lazyInitRetryUsed = false;
  private readonly allocations = new Map<number, number>();
  private nextLocalProcessId = 1_000;
  private nextLocalIncarnation = 1;
  private readonly liveOperations = new Map<number, LiveExecSpoolRecord>();
  private readonly checkpointTimers = new Map<number, NodeJS.Timeout>();
  private readonly checkpointFlights = new Map<number, Promise<void>>();
  private readonly maxWriteStdinYieldTimeMs: number;
  private readonly requireDurableSpool: boolean;

  constructor(maxWriteStdinYieldTimeMs: number, requireDurableSpool = false) {
    this.maxWriteStdinYieldTimeMs = Math.max(maxWriteStdinYieldTimeMs, MIN_EMPTY_YIELD_TIME_MS);
    this.requireDurableSpool = requireDurableSpool;
  }

  /** The custody registry drops ownership only when this manager really discards an id. */
  setProcessReleaseListener(listener: (processId: number) => void): void {
    this.releaseListener = listener;
  }

  /** Rehydrate the durable owner projection for startup and lazy spool recovery alike. */
  setSpoolRestoreListener(listener: (records: CompletedExecSpoolRecord[]) => void): void {
    this.spoolRestoreListener = listener;
  }

  /** Presentation observers may reread the manager after a process starts, exits or is discarded. */
  setProcessChangeListener(listener: () => void): void {
    this.processChangeListener = listener;
  }

  /** Called once during startup, before tools are exposed. Unread results survive app restarts. */
  async initializeSpool(userDataDir: string): Promise<CompletedExecSpoolRecord[]> {
    this.spoolUserDataDir = userDataDir;
    if (this.spoolInitFlight) return this.spoolInitFlight;
    const run = (async () => {
      this.lastSpoolInitAttemptAt = Date.now();
      const durable = new FileExecSpool(userDataDir);
      try {
        const records = await durable.initialize();
        this.spool = durable;
        for (const record of records) {
          this.spooled.set(record.processId, record);
        }
        this.spoolInitialized = true;
        this.spoolInitializationError = null;
        this.lazyInitRetryUsed = false;
        this.spoolRestoreListener?.(records);
        this.notifyProcessChange();
        return records;
      } catch (error) {
        this.spoolInitialized = false;
        this.spoolInitializationError = error instanceof Error ? error.message : 'Durable terminal result storage could not be opened or validated.';
        this.notifyProcessChange();
        throw new Error(this.spoolInitializationError);
      }
    })();
    this.spoolInitFlight = run;
    try { return await run; }
    finally { if (this.spoolInitFlight === run) this.spoolInitFlight = null; }
  }

  private async ensureSpoolReady(): Promise<void> {
    if (!this.requireDurableSpool || this.spoolInitialized) return;
    if (!this.spoolUserDataDir) throw UnifiedExecError.terminalStorageUnavailable();
    if (this.spoolInitFlight) {
      try { await this.spoolInitFlight; return; }
      catch { throw UnifiedExecError.terminalStorageUnavailable(); }
    }
    const firstLazyRetry = !this.lazyInitRetryUsed;
    if (!firstLazyRetry && Date.now() - this.lastSpoolInitAttemptAt < 1_000)
      throw UnifiedExecError.terminalStorageUnavailable();
    this.lazyInitRetryUsed = true;
    try { await this.initializeSpool(this.spoolUserDataDir); }
    catch { throw UnifiedExecError.terminalStorageUnavailable(); }
  }

  /** Durable monotonic id and incarnation allocation; the ledger commit precedes returning it. */
  async allocateProcessIdDurably(): Promise<{ processId: number; incarnation: number }> {
    try {
      await this.ensureSpoolReady();
      const allocation = await this.spool.allocate();
      this.reservedProcessIds.add(allocation.processId);
      this.allocations.set(allocation.processId, allocation.incarnation);
      return allocation;
    } catch (error) {
      if (error instanceof UnifiedExecError) throw error;
      if ((error as Error).message.includes('exhausted')) throw UnifiedExecError.terminalCapacity('terminal process id range is exhausted; new_command_started=false');
      throw UnifiedExecError.terminalStorageUnavailable();
    }
  }

  /** Read-only trusted-local access. Model callers must use owner-scoped read paths instead. */
  retainedResultRecords(): CompletedExecSpoolRecord[] {
    return [...this.spooled.values()].map(record => ({ ...record }));
  }

  retainedResultRecord(processId: number): CompletedExecSpoolRecord | null {
    const record = this.spooled.get(processId);
    return record ? { ...record } : null;
  }

  /** Discard only the exact durable result row shown to a trusted local operator. */
  async discardRetainedResult(processId: number, incarnation: number, principal: string | null): Promise<boolean> {
    const record = this.spooled.get(processId);
    if (!record || record.incarnation !== incarnation || record.principal !== principal) return false;
    if (!await this.spool.removeIf(processId, incarnation, principal)) return false;
    if (this.spooled.get(processId)?.incarnation !== incarnation) return false;
    this.spooled.delete(processId);
    this.spoolOffers.delete(processId);
    this.releaseProcessId(processId);
    this.notifyProcessChange();
    return true;
  }

  async promotePrincipal(processId: number, requestPrincipal: string, sessionId: string, conversationId?: string): Promise<void> {
    const entry = this.processes.get(processId);
    if (entry?.ownerPrincipal === requestPrincipal) {
      entry.ownerPrincipal = sessionId;
      entry.sessionId = sessionId;
      if (conversationId) entry.conversationId = conversationId;
    }
    const record = this.spooled.get(processId);
    if (!record || record.principal !== requestPrincipal) return;
    const promoted: CompletedExecSpoolRecord = { ...record, principal: sessionId, sessionId,
      ...(conversationId ? { conversationId } : {}), ownerKind: 'session' };
    await this.spool.update(promoted);
    this.spooled.set(processId, promoted);
    this.notifyProcessChange();
  }

  private notifyProcessChange(): void {
    this.processChangeListener?.();
  }

  /** Test/in-memory allocator. The production caller uses the durable monotonic allocator below. */
  allocateProcessId(): number {
    if (this.requireDurableSpool) throw UnifiedExecError.terminalStorageUnavailable();
    while (this.nextLocalProcessId <= Number.MAX_SAFE_INTEGER &&
      (this.reservedProcessIds.has(this.nextLocalProcessId) || this.completed.has(this.nextLocalProcessId) || this.spooled.has(this.nextLocalProcessId)))
      this.nextLocalProcessId++;
    if (this.nextLocalProcessId > Number.MAX_SAFE_INTEGER) throw UnifiedExecError.terminalCapacity('terminal process id range is exhausted; new_command_started=false');
    const processId = this.nextLocalProcessId++;
    this.reservedProcessIds.add(processId);
    this.allocations.set(processId, this.nextLocalIncarnation++);
    return processId;
  }

  releaseProcessId(processId: number): void {
    const timer = this.checkpointTimers.get(processId);
    if (timer) clearTimeout(timer);
    this.checkpointTimers.delete(processId);
    this.liveOperations.delete(processId);
    this.allocations.delete(processId);
    this.reservedProcessIds.delete(processId);
    this.processes.delete(processId);
    this.completed.delete(processId);
    if (!this.spooled.has(processId)) this.releaseListener?.(processId);
    this.notifyProcessChange();
  }

  private makeSpoolRecord(entry: ProcessEntry, pendingOverride?: Buffer): CompletedExecSpoolRecord {
    const raw = entry.process.retainedOutput();
    const display = entry.process.retainedDisplayOutput();
    const pending = pendingOverride ?? entry.process.completedOutput() ?? Buffer.alloc(0);
    return {
      version: 1,
      processId: entry.processId,
      incarnation: entry.incarnation,
      ownerKind: entry.ownerPrincipal === null ? 'anonymous' : entry.ownerPrincipal.startsWith('request:') ? 'request' : 'session',
      principal: entry.ownerPrincipal,
      ...(entry.requestId ? { requestId: entry.requestId } : {}),
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
      ...(entry.setupProfileId ? { setupProfileId: entry.setupProfileId } : {}),
      command: entry.hookCommand,
      cwd: entry.cwd,
      startedAt: entry.startedAt,
      completedAt: Date.now(),
      exitCode: entry.process.exitCode(),
      benignExit: entry.process.benignExit(entry.classifyExit),
      outputClosed: entry.process.outputClosed,
      outputInterrupted: entry.process.outputInterrupted,
      outputCaptureIncomplete: false,
      ...(entry.provider ? { provider: entry.provider } : {}),
      rawOutput: raw.toString('base64'),
      ...(display.equals(raw) ? {} : { displayOutput: display.toString('base64') }),
      pendingOutput: pending.toString('base64'),
      ...(entry.initialOutputOffset === undefined ? {} : { initialOutputOffset: entry.initialOutputOffset }),
      outputSha256: createHash('sha256').update(raw).digest('hex'),
      rawOmittedBytes: entry.process.rawOmittedBytes(),
      displayOmittedBytes: entry.process.displayOmittedBytes(),
      acknowledgedOffset: 0
    };
  }

  private cacheAcknowledged(record: CompletedExecSpoolRecord, identity: object): void {
    this.completed.set(record.processId, { identity, rawOutput: Buffer.from(record.rawOutput, 'base64'),
      ...(record.displayOutput === undefined ? {} : { displayOutput: Buffer.from(record.displayOutput, 'base64') }),
      exitCode: record.exitCode, benignExit: record.benignExit });
    while (this.completed.size > MAX_COMPLETED_EXEC_RESULTS) this.releaseProcessId(this.completed.keys().next().value!);
  }

  private async persistExitedEntry(entry: ProcessEntry, pendingOverride?: Buffer): Promise<void> {
    if (this.processes.get(entry.processId) !== entry || !entry.process.hasExited() ||
        (!entry.process.outputClosed && !entry.process.outputInterrupted)) return;
    const timer = this.checkpointTimers.get(entry.processId);
    if (timer) clearTimeout(timer);
    this.checkpointTimers.delete(entry.processId);
    await this.checkpointFlights.get(entry.processId);
    let record = this.makeSpoolRecord(entry, pendingOverride);
    const existing = this.spool.get(entry.processId);
    if (existing) {
      if (existing.incarnation !== record.incarnation || existing.principal !== record.principal ||
          existing.ownerKind !== record.ownerKind || existing.outputSha256 !== record.outputSha256 ||
          existing.pendingOutput !== record.pendingOutput)
        throw new Error('Terminal completion conflicts with an already committed custody record.');
      // A prior attempt may have committed the immutable result and failed during live-row
      // cleanup. Preserve its delivery cursor and retry only the unfinished cleanup.
      record = existing;
    } else {
      await this.spool.put(record);
      record = this.spool.get(entry.processId) ?? record;
    }
    await this.spool.removeLive(entry.processId, entry.incarnation);
    this.spooled.set(entry.processId, record);
    this.liveOperations.delete(entry.processId);
    this.allocations.delete(entry.processId);
    this.checkpointFlights.delete(entry.processId);
    this.processes.delete(entry.processId);
    this.reservedProcessIds.delete(entry.processId);
    this.spoolFailures.delete(entry.processId);
    this.notifyProcessChange();
  }

  private liveSpoolRecord(request: ExecCommandRequest, incarnation: number, startedAt: number): LiveExecSpoolRecord {
    const principal = request.ownerPrincipal ?? null;
    return { version: 1, processId: request.processId, incarnation,
      ownerKind: principal === null ? 'anonymous' : principal.startsWith('request:') ? 'request' : 'session', principal,
      ...(request.provider ? { provider: request.provider } : {}),
      ...(request.requestId ? { requestId: request.requestId } : {}), ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.conversationId ? { conversationId: request.conversationId } : {}), ...(request.setupProfileId ? { setupProfileId: request.setupProfileId } : {}),
      command: request.hookCommand, cwd: request.displayCwd, startedAt, rawOutput: '', rawOmittedBytes: 0, displayOmittedBytes: 0 };
  }

  private scheduleLiveCheckpoint(process: UnifiedExecProcess, processId: number, incarnation: number): void {
    if (this.checkpointTimers.has(processId)) return;
    const timer = setTimeout(() => {
      this.checkpointTimers.delete(processId);
      const operation = this.liveOperations.get(processId);
      if (!operation || operation.incarnation !== incarnation || this.processes.get(processId)?.process !== process) return;
      const raw = process.retainedOutput(), display = process.retainedDisplayOutput();
      const checkpoint: LiveExecSpoolRecord = { ...operation, rawOutput: raw.toString('base64'),
        ...(display.equals(raw) ? {} : { displayOutput: display.toString('base64') }),
        rawOmittedBytes: process.rawOmittedBytes(), displayOmittedBytes: process.displayOmittedBytes() };
      const flight = this.spool.updateLive(checkpoint).then(() => {
        if (this.liveOperations.get(processId)?.incarnation === incarnation) this.liveOperations.set(processId, checkpoint);
      }).catch(() => { this.spoolFailures.add(processId); this.notifyProcessChange(); });
      this.checkpointFlights.set(processId, flight);
      void flight.finally(() => { if (this.checkpointFlights.get(processId) === flight) this.checkpointFlights.delete(processId); });
    }, 500);
    timer.unref?.();
    this.checkpointTimers.set(processId, timer);
  }

  private async captureExitedEntry(entry: ProcessEntry): Promise<void> {
    // This callback is also issued after a live exec response is returned. A live process
    // necessarily has open stdout/stderr pipes, so the post-exit close grace must never be
    // used as a lifetime cap for the process itself.
    if (entry.initialExecCommandActive || !entry.process.hasExited()) return;
    if (!entry.process.outputClosed && !entry.process.outputInterrupted &&
        !await entry.process.waitForOutputClosed(POST_EXIT_CLOSE_WAIT_CAP_MS)) await entry.process.terminate();
    const release = await entry.process.interactionLock.lock();
    try {
      await this.persistExitedEntry(entry);
    } catch {
      this.spoolFailures.add(entry.processId);
      this.notifyProcessChange();
    } finally { release(); }
  }

  /** Commit received output before a deliberately terminated session releases its reservation. */
  private async sealExitedEntry(entry: ProcessEntry, allowInitialExec: boolean): Promise<void> {
    if (!entry.process.outputClosed && !entry.process.outputInterrupted &&
        !await entry.process.waitForOutputClosed(POST_EXIT_CLOSE_WAIT_CAP_MS)) await entry.process.terminate();
    const release = await entry.process.interactionLock.lock();
    try {
      if (this.processes.get(entry.processId) !== entry) return;
      if (entry.initialExecCommandActive && !allowInitialExec) return;
      await this.persistExitedEntry(entry);
    } catch (error) {
      this.spoolFailures.add(entry.processId);
      this.notifyProcessChange();
      throw error;
    } finally { release(); }
  }

  async execCommand(request: ExecCommandRequest): Promise<ExecCommandToolOutput> {
    let process: UnifiedExecProcess;
    try {
      await this.ensureSpoolReady();
      this.ensureProcessCapacity(request.processId);
      void this.retryFailedCaptures();
    } catch (error) {
      this.releaseProcessId(request.processId);
      throw error;
    }
    const incarnation = this.allocations.get(request.processId);
    if (incarnation === undefined) {
      this.releaseProcessId(request.processId);
      throw UnifiedExecError.createProcess('terminal session allocation is missing; no command was started');
    }
    const start = Date.now();
    const liveOperation = this.liveSpoolRecord(request, incarnation, start);
    try {
      // This durable operation record precedes OS process creation. A restart turns it into an
      // interrupted unread result; it can never be interpreted as permission to respawn.
      await this.spool.putLive(liveOperation);
      this.liveOperations.set(request.processId, liveOperation);
    } catch {
      this.releaseProcessId(request.processId);
      throw UnifiedExecError.terminalStorageUnavailable();
    }
    let spawnedProcess: UnifiedExecProcess | null = null;
    let checkpointBeforeSpawnReturned = false;
    try {
      // `UnifiedExecRuntime::run` prefixes every PowerShell script before it reaches the
      // process launcher so pipe-mode output is UTF-8 just like PTY output.
      const command =
        request.shellType === 'powershell' ? prefixPowershellScriptWithUtf8(request.command) : request.command;
      process = await UnifiedExecProcess.spawn({
        batchMarker: request.batchMarker,
        command,
        shellType: request.shellType,
        cwd: request.cwd,
        env: request.env,
        tty: request.tty,
        onOutputCheckpoint: () => {
          if (spawnedProcess) this.scheduleLiveCheckpoint(spawnedProcess, request.processId, incarnation);
          else checkpointBeforeSpawnReturned = true;
        }
      });
      spawnedProcess = process;
      if (checkpointBeforeSpawnReturned) this.scheduleLiveCheckpoint(process, request.processId, incarnation);
    } catch (error) {
      await this.spool.removeLive(request.processId, incarnation).catch(() => undefined);
      this.liveOperations.delete(request.processId);
      this.releaseProcessId(request.processId);
      throw error instanceof UnifiedExecError
        ? error
        : UnifiedExecError.createProcess(error instanceof Error ? error.message : String(error));
    }

    const wallStart = performance.now();
    // Stored before the yield wait, so interrupting the call cannot drop the session.
    const processStartedAlive = !process.hasExited() && process.exitCode() === null;
    if (processStartedAlive) {
      const entry: ProcessEntry = {
        process,
        processId: request.processId,
        incarnation,
        cwd: request.displayCwd,
        hookCommand: request.hookCommand,
        tty: request.tty,
        startedAt: start,
        ownerPrincipal: request.ownerPrincipal ?? null,
        provider: request.provider,
        requestId: request.requestId,
        sessionId: request.sessionId,
        conversationId: request.conversationId,
        setupProfileId: request.setupProfileId,
        initialExecCommandActive: true,
        classifyExit: request.classifyExit, batchMarker: request.batchMarker
      };
      this.processes.set(request.processId, entry);
      void process.completion.then(
        () => { this.notifyProcessChange(); void this.captureExitedEntry(entry); },
        () => { this.notifyProcessChange(); void this.captureExitedEntry(entry); }
      );
    }

    const deadline = start + clampYieldTime(request.yieldTimeMs);
    const collected = await collectOutputUntilDeadline(process, deadline);
    const wallTimeMs = Math.max(0, performance.now() - wallStart);

    const visible = collected.display ?? collected.raw;
    const rawOutput = collected.raw.toBytesWithOmissionMarker();
    if (processStartedAlive) {
      const entry = this.processes.get(request.processId);
      if (entry?.process === process) {
        entry.initialOutputOffset = rawOutput.length;
        entry.delivery = { offset: entry.initialOutputOffset };
      }
    }
    const originalTokenCount = approxTokensFromByteCount(visible.totalBytes());
    const outputOmittedBytes = visible.omittedBytes() === 0 ? null : visible.omittedBytes();
    const chunkId = generateChunkId();

    const failure = process.failureMessage();
    if (failure !== null) {
      this.releaseProcessId(request.processId);
      throw UnifiedExecError.processFailed(failure);
    }

    let responseProcessId: number | null;
    let exitCode: number | null;
    if (processStartedAlive) {
      const status = this.refreshProcessState(request.processId);
      if (status.kind === 'alive') {
        responseProcessId = status.processId;
        exitCode = status.exitCode;
      } else if (status.kind === 'exited') {
        responseProcessId = null;
        exitCode = status.exitCode;
      } else if (this.spooled.has(request.processId) && process.hasExited()) {
        // Shutdown may have durably sealed a process while its initial exec response was
        // still collecting. The response still owns this completion and can finish normally.
        responseProcessId = null;
        exitCode = process.exitCode();
      } else {
        throw UnifiedExecError.unknownProcessId(request.processId);
      }
    } else {
      const entry: ProcessEntry = { process, processId: request.processId, cwd: request.displayCwd,
        hookCommand: request.hookCommand, tty: request.tty, startedAt: start, ownerPrincipal: request.ownerPrincipal ?? null,
        provider: request.provider, requestId: request.requestId, sessionId: request.sessionId,
        conversationId: request.conversationId, setupProfileId: request.setupProfileId,
        incarnation, initialExecCommandActive: false, classifyExit: request.classifyExit, batchMarker: request.batchMarker };
      this.processes.set(request.processId, entry);
      if (!process.outputClosed && !process.outputInterrupted &&
          !await process.waitForOutputClosed(POST_EXIT_CLOSE_WAIT_CAP_MS)) await process.terminate();
      // The completed display buffer includes bytes emitted after the leader exited but before
      // inherited stdout/stderr handles closed. The initial yield buffer can be only a prefix.
      try { await this.persistExitedEntry(entry); }
      catch { this.spoolFailures.add(request.processId); }
      if (!this.spooled.has(request.processId)) {
        // Return the exact completed id so a later read can retry capture without respawning.
        this.processes.set(request.processId, entry);
        this.reservedProcessIds.add(request.processId);
      }
      responseProcessId = null;
      exitCode = process.exitCode();
    }

    const response: ExecCommandToolOutput = {
      ...(responseProcessId === null ? { completedSessionId: request.processId } : {
        completion: process.completion.then(async completion => {
          if (!process.outputClosed && !process.outputInterrupted) {
            const closed = process.outputClosedNotify.notified();
            try { await raceWithTimeout([closed], POST_EXIT_CLOSE_WAIT_CAP_MS); } finally { closed.dispose(); }
          }
          return { ...completion, benignExit: process.benignExit(request.classifyExit), outputInterrupted: process.outputInterrupted };
        })
      }),
      benignExit: process.benignExit(request.classifyExit),
      ...(process.outputInterrupted ? { terminalOutputInterrupted: true } : {}),
      chunkId,
      wallTimeMs,
      rawOutput,
      ...(collected.display ? { displayOutput: collected.display.toBytesWithOmissionMarker() } : {}),
      truncationPolicy: request.truncationPolicy,
      maxOutputTokens: request.maxOutputTokens,
      processId: responseProcessId,
      exitCode,
      originalTokenCount,
      outputOmittedBytes,
      ...(this.spoolFailures.has(request.processId) ? { terminalStoragePending: true } : {})
    };
    if (processStartedAlive) {
      const entry = this.processes.get(request.processId);
      if (entry?.process === process) {
        entry.initialExecCommandActive = false;
        if (process.hasExited() && (process.outputClosed || process.outputInterrupted)) {
          await this.captureExitedEntry(entry);
          if (this.spoolFailures.has(request.processId)) response.terminalStoragePending = true;
        } else {
          void this.captureExitedEntry(entry);
        }
      }
    }
    return response;
  }

  async writeStdin(request: WriteStdinRequest): Promise<ExecCommandToolOutput> {
    const replay = (identity?: object): ExecCommandToolOutput | null => {
      const saved = this.completed.get(request.processId);
      if (!saved) return null;
      if (identity && saved.identity !== identity) throw UnifiedExecError.unknownProcessId(request.processId);
      if (request.input !== '') throw UnifiedExecError.processFailed('Process already completed; no input was sent. Use empty chars to read its retained output.');
      return { ...saved, chunkId: generateChunkId(), wallTimeMs: 0, processId: null,
        completedSessionId: request.processId, replayed: true, originalTokenCount: approxTokenCount((saved.displayOutput ?? saved.rawOutput).toString('utf8')),
        outputOmittedBytes: null, truncationPolicy: request.truncationPolicy, maxOutputTokens: request.maxOutputTokens };
    };
    const saved = replay();
    if (saved) return saved;
    const spooled = this.spooled.get(request.processId);
    if (spooled) {
      if (request.input !== '') throw UnifiedExecError.processFailed('Process already completed; no input was sent. Use empty chars to read its retained output.');
      const pending = Buffer.from(spooled.pendingOutput, 'base64');
      const source = pending.length ? pending : Buffer.from(spooled.rawOutput, 'base64');
      const readOffset = (spooled.initialOutputOffset ?? 0) > 0 ? 0 : spooled.acknowledgedOffset;
      const visible = source.subarray(readOffset);
      const rawOutput = visible;
      return { chunkId: generateChunkId(), wallTimeMs: 0, rawOutput,
        processId: null, completedSessionId: request.processId,
        exitCode: spooled.exitCode, originalTokenCount: approxTokenCount(rawOutput.toString('utf8')),
        outputOmittedBytes: spooled.rawOmittedBytes || null, truncationPolicy: request.truncationPolicy,
        maxOutputTokens: request.maxOutputTokens, benignExit: spooled.benignExit, replayed: true,
        terminalOutputInterrupted: spooled.outputInterrupted && !spooled.outputCaptureIncomplete,
        terminalOutputCheckpointed: spooled.outputCaptureIncomplete === true };
    }
    const entry = this.processes.get(request.processId);
    if (!entry) throw UnifiedExecError.unknownProcessId(request.processId);
    if (entry.process.hasExited() && (entry.process.outputClosed || entry.process.outputInterrupted) && this.spoolFailures.has(request.processId)) {
      await this.captureExitedEntry(entry);
      if (this.spooled.has(request.processId)) return this.writeStdin(request);
    }
    const locked = entry.process;

    // Reads and writes against one session must not overlap: they share a draining buffer.
    const release = await locked.interactionLock.lock();
    try {
      // Exit capture may have committed the spool while this poll was waiting for the
      // per-process lock. The durable result now owns the read path.
      if (this.spooled.has(request.processId)) return this.writeStdin(request);
      const saved = replay(locked.identity);
      if (saved) return saved;
      const current = this.processes.get(request.processId);
      if (!current || current.process !== locked) throw UnifiedExecError.unknownProcessId(request.processId);
      const { process, tty } = { process: current.process, tty: current.tty };

      let statusAfterWrite: ProcessStatus | null = null;
      if (request.input !== '') {
        if (process.hasExited()) throw UnifiedExecError.processFailed('Process already completed; no input was sent. Use empty chars to read its retained output.');
        if (!tty) {
          if (request.input === INTERRUPT) {
            await process.interrupt();
          } else {
            throw UnifiedExecError.stdinClosed();
          }
        } else {
          try {
            await process.write(request.input);
            // A brief window so the child's reaction is more likely to land in the poll below.
            await sleep(100);
          } catch (error) {
            const status = this.refreshProcessState(request.processId);
            if (status.kind === 'exited') {
              statusAfterWrite = status;
            } else if (error instanceof UnifiedExecError && error.kind === 'process_failed') {
              await process.terminate();
              this.releaseProcessId(request.processId);
              throw error;
            } else {
              throw error;
            }
          }
        }
      }

      const maxEmptyYield = Math.max(
        request.maxWriteStdinYieldTimeMs ?? this.maxWriteStdinYieldTimeMs,
        MIN_EMPTY_YIELD_TIME_MS
      );
      const base = Math.max(request.yieldTimeMs, MIN_YIELD_TIME_MS);
      const yieldTimeMs =
        request.input === ''
          ? Math.min(Math.max(base, MIN_EMPTY_YIELD_TIME_MS), maxEmptyYield)
          : Math.min(base, MAX_YIELD_TIME_MS);

      const start = Date.now();
      const wallStart = performance.now();
      // Empty calls are polls, not collection windows. Once the process produces anything,
      // returning it immediately saves the caller another multi-second connector round trip;
      // bytes that arrive later remain in the draining buffer for the next poll. Non-empty
      // writes keep Codex's collection-window behavior so one interactive response is gathered.
      const collected = await collectOutputUntilDeadline(process, start + yieldTimeMs, request.input === '');
      const wallTimeMs = Math.max(0, performance.now() - wallStart);

      const visible = collected.display ?? collected.raw;
      const originalTokenCount = approxTokensFromByteCount(visible.totalBytes());
      const outputOmittedBytes = visible.omittedBytes() === 0 ? null : visible.omittedBytes();
      // An explicit poll may replay an offered-but-unacknowledged page, but must not
      // repeat earlier pages that this caller has already acknowledged automatically.
      const deliveredOffset = current.delivery?.offset ?? 0;
      const rawOutput = deliveredOffset > 0
        ? visible.toBytesWithOmissionMarker().subarray(deliveredOffset)
        : collected.raw.toBytesWithOmissionMarker();
      const chunkId = generateChunkId();

      const failure = process.failureMessage();
      if (failure !== null) {
        this.releaseProcessId(request.processId);
        throw UnifiedExecError.processFailed(failure);
      }

      const status = statusAfterWrite ?? this.refreshProcessState(request.processId);
      let responseProcessId: number | null;
      let exitCode: number | null;
      if (status.kind === 'alive') {
        responseProcessId = status.processId;
        exitCode = status.exitCode;
      } else if (status.kind === 'exited') {
        responseProcessId = null;
        exitCode = status.exitCode;
      } else if (process.hasExited()) {
        responseProcessId = null;
        exitCode = process.exitCode();
      } else {
        throw UnifiedExecError.unknownProcessId(request.processId);
      }

      return {
        ...(responseProcessId === null ? { completedSessionId: request.processId } : {}),
        benignExit: process.benignExit(current.classifyExit),
        ...(process.outputInterrupted ? { terminalOutputInterrupted: true } : {}),
        ...(this.spoolFailures.has(request.processId) ? { terminalStoragePending: true } : {}),
        chunkId,
        wallTimeMs,
        rawOutput,
        ...(collected.display ? { displayOutput: deliveredOffset > 0 ? rawOutput : collected.display.toBytesWithOmissionMarker() } : {}),
        truncationPolicy: request.truncationPolicy,
        maxOutputTokens: request.maxOutputTokens,
        processId: responseProcessId,
        exitCode,
        originalTokenCount,
        outputOmittedBytes
      };
    } finally {
      release();
    }
  }

  /** Live sessions, oldest id first. */
  listProcesses(): BackgroundTerminalInfo[] {
    return [...this.processes.values()]
      .filter((entry) => !entry.process.hasExited())
      .sort((left, right) => left.processId - right.processId)
      .map((entry) => ({
        processId: entry.processId,
        incarnation: entry.incarnation,
        command: entry.hookCommand,
        cwd: entry.cwd,
        pid: entry.process.pid,
        tty: entry.tty,
        startedAt: entry.startedAt
      }));
  }

  /** Non-destructive obligation view for a caller-owned set of retained sessions. */
  backgroundState(processIds: ReadonlySet<number>): BackgroundExecState {
    const running: number[] = [];
    const exitedUnread: Array<{ processId: number; exitCode: number | null }> = [];
    for (const entry of this.processes.values()) {
      if (entry.initialExecCommandActive) continue;
      if (!processIds.has(entry.processId)) continue;
      if (entry.process.hasExited()) {
        exitedUnread.push({ processId: entry.processId, exitCode: entry.process.exitCode() });
      } else {
        running.push(entry.processId);
      }
    }
    for (const record of this.spooled.values()) {
      if (processIds.has(record.processId)) exitedUnread.push({ processId: record.processId, exitCode: record.exitCode });
    }
    return {
      running: running.sort((left, right) => left - right),
      exitedUnread: exitedUnread.sort((left, right) => left.processId - right.processId)
    };
  }

  /** Exited rows not handled by the starting exec; polling releases these rows. */
  exitedUnread(processIds: ReadonlySet<number>): Array<{ processId: number; exitCode: number | null }> {
    return this.backgroundState(processIds).exitedUnread;
  }

  /** A later owner call acknowledges a successfully published page, even within one request ID. */
  async acknowledgeCompletedOutput(processIds: ReadonlySet<number>, startedAt: number, except?: number): Promise<number[]> {
    const retired: number[] = [];
    for (const id of processIds) {
      if (id === except) continue; // Explicit polling still owns its normal result path.
      const entry = this.processes.get(id);
      if (!entry?.delivery?.offer) continue;
      const release = await entry.process.interactionLock.lock();
      try {
        if (this.processes.get(id) !== entry) continue;
        const offered = entry.delivery?.offer;
        if (!offered || offered.publication.failed || offered.publication.completedAt === null ||
            startedAt <= offered.publication.completedAt) continue;
        const output = entry.process.completedOutput();
        if (output === null) continue;
        if (offered.end >= output.length) {
          await this.persistExitedEntry(entry);
          const record = this.spooled.get(id);
          if (!record) continue;
          const completed = { ...record, acknowledgedOffset: offered.end };
          await this.spool.update(completed);
          this.spooled.set(id, completed);
          await this.spool.remove(id);
          this.spooled.delete(id);
          this.cacheAcknowledged(completed, entry.process.identity);
          retired.push(id);
          this.notifyProcessChange();
        } else entry.delivery = { offset: offered.end };
      } finally { release(); }
    }
    for (const id of processIds) {
      if (id === except) continue;
      const record = this.spooled.get(id);
      const offered = this.spoolOffers.get(id);
      if (!record || !offered || offered.publication.failed || offered.publication.completedAt === null ||
          startedAt <= offered.publication.completedAt || this.spooled.get(id) !== record) continue;
      const next = { ...record, acknowledgedOffset: offered.end };
      await this.spool.update(next);
      this.spooled.set(id, next);
      this.spoolOffers.delete(id);
      const output = Buffer.from(next.pendingOutput, 'base64');
      if (offered.end >= output.length) {
        await this.spool.remove(id);
        this.spooled.delete(id);
        this.cacheAcknowledged(next, {});
        retired.push(id);
      }
    }
    return retired;
  }

  /**
   * Offer one bounded page without draining the process. A broken response reoffers the
   * same bytes; an older concurrent response cannot advance a newer delivery cursor.
   */
  async offerCompletedOutput(
    processIds: ReadonlySet<number>, publication: OutputPublication, maxBytes: number
  ): Promise<CompletedOutputPage | null> {
    if (publication.failed || maxBytes < 4) return null;
    for (const { processId } of this.backgroundState(processIds).exitedUnread) {
      const entry = this.processes.get(processId);
      if (!entry) {
        const record = this.spooled.get(processId);
        if (!record) continue;
        const prior = this.spoolOffers.get(processId);
        if (prior && !prior.publication.failed) continue;
        const output = Buffer.from(record.pendingOutput, 'base64');
        const start = Math.max(record.acknowledgedOffset, record.initialOutputOffset ?? 0);
        if (output.length > 0 && start >= output.length) continue;
        let end = Math.min(output.length, start + Math.floor(maxBytes));
        while (end > start && end < output.length && (output[end]! & 0xc0) === 0x80) end--;
        if (end === start && output.length > start) continue;
        this.spoolOffers.set(processId, { end, publication });
        return { processId, command: record.command, exitCode: record.exitCode,
          output: output.subarray(start, end).toString('utf8'), start, end, total: output.length,
          outputInterrupted: record.outputInterrupted, outputCaptureIncomplete: record.outputCaptureIncomplete === true };
      }
      const release = await entry.process.interactionLock.lock();
      try {
        if (this.processes.get(processId) !== entry || entry.initialExecCommandActive) continue;
        const output = entry.process.completedOutput();
        if (output === null) continue;
        const delivery = entry.delivery ??= { offset: 0 };
        // An in-flight or published offer owns this page until failure or later receipt.
        if (delivery.offer && !delivery.offer.publication.failed) continue;
        const start = delivery.offset;
        let end = Math.min(output.length, start + Math.floor(maxBytes));
        // Do not split a UTF-8 character across separately rendered MCP responses.
        while (end > start && end < output.length && (output[end]! & 0xc0) === 0x80) end--;
        if (end === start && output.length > start) continue;
        delivery.offer = { end, publication };
        return { processId, command: entry.hookCommand, exitCode: entry.process.exitCode(),
          output: output.subarray(start, end).toString('utf8'), start, end, total: output.length,
          outputInterrupted: entry.process.outputInterrupted, outputCaptureIncomplete: false };
      } finally { release(); }
    }
    return null;
  }

  async terminateProcess(processId: number, expectedIncarnation?: number): Promise<boolean> {
    const entry = this.processes.get(processId);
    if (!entry) return false;
    // Renderer actions carry the exact live incarnation they displayed. Refuse a stale row after
    // natural exit, and refuse ABA reuse of the same numeric id without consuming retained output.
    if (expectedIncarnation !== undefined &&
        (entry.incarnation !== expectedIncarnation || entry.process.hasExited())) return false;
    if (!entry.process.hasExited() || !entry.process.outputClosed) await entry.process.terminate();
    const current = this.processes.get(processId);
    if (current && current.process === entry.process) {
      // Match Codex's InitialExecCommandGuard: the initial exec response still
      // owns this entry until it has refreshed the process's terminal state.
      // Removing it here would turn a successful concurrent termination into
      // an UnknownProcessId error in that original exec_command call.
      if (current.initialExecCommandActive) return true;
      try {
        await this.sealExitedEntry(current, false);
      } catch {
        throw UnifiedExecError.processFailed(
          'The process was terminated, but its output could not be saved. Its reservation remains held for recovery.'
        );
      }
    }
    return true;
  }

  async terminateAllProcesses(): Promise<void> {
    const entries = [...this.processes.values()];
    // This cache contains only results whose output was already acknowledged. Keep unread
    // durable spool records and their custody across a forced update or app shutdown.
    for (const id of this.completed.keys()) this.releaseListener?.(id);
    this.completed.clear();
    this.notifyProcessChange();
    // Handle every process independently so one kill or disk error cannot leave the rest
    // running. A failed commit deliberately leaves that process and its reservation visible.
    const results = await Promise.allSettled(entries.map(async (entry) => {
      if (this.processes.get(entry.processId) !== entry) return;
      // An exited leader can still have descendants holding inherited output pipes open.
      // Ask the process-tree helper to close those pipes before waiting on the spool boundary.
      if (!entry.process.hasExited() || !entry.process.outputClosed) await entry.process.terminate();
      await this.sealExitedEntry(entry, true);
    }));
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed.length > 0) {
      throw new Error(`${failed.length} terminal session(s) could not be safely sealed during shutdown; their reservations remain held.`);
    }
  }

  private refreshProcessState(processId: number): ProcessStatus {
    const entry = this.processes.get(processId);
    if (!entry) return { kind: 'unknown' };
    const exitCode = entry.process.exitCode();
    if (entry.process.hasExited()) {
      // Exit alone does not close inherited streams; the asynchronous capture owner waits for both.
      return { kind: 'exited', exitCode };
    }
    return { kind: 'alive', exitCode, processId: entry.processId };
  }

  inventory(): { reserved: number; running: number; exitedOutputOpen: number; exitedOutputClosed: number; exitedOutputInterrupted: number;
    unreadSpooled: number; interruptedSpooled: number; checkpointedSpooled: number; completedCache: number; spoolBytes: number; storageFailures: number;
    spoolState: 'memory' | 'ready' | 'unavailable' | 'not-initialized'; spoolError: string | null } {
    let running = 0, exitedOutputOpen = 0, exitedOutputClosed = 0, exitedOutputInterrupted = 0;
    for (const entry of this.processes.values()) {
      if (!entry.process.hasExited()) running++;
      else if (entry.process.outputInterrupted) exitedOutputInterrupted++;
      else if (entry.process.outputClosed) exitedOutputClosed++;
      else exitedOutputOpen++;
    }
    const interruptedSpooled = [...this.spooled.values()].filter(record => record.outputInterrupted).length;
    const checkpointedSpooled = [...this.spooled.values()].filter(record => record.outputCaptureIncomplete === true).length;
    return { reserved: this.reservedProcessIds.size, running, exitedOutputOpen, exitedOutputClosed, exitedOutputInterrupted,
      unreadSpooled: this.spooled.size, interruptedSpooled, checkpointedSpooled, completedCache: this.completed.size, spoolBytes: this.spool.bytes(), storageFailures: this.spoolFailures.size,
      spoolState: this.spoolInitialized ? 'ready' : this.requireDurableSpool
        ? this.spoolInitializationError ? 'unavailable' : 'not-initialized' : 'memory',
      spoolError: this.spoolInitializationError ?? (this.spoolFailures.size ? 'Some terminal output could not be durably stored.' : null) };
  }

  private async retryFailedCaptures(): Promise<void> {
    for (const id of [...this.spoolFailures]) {
      const entry = this.processes.get(id);
      if (entry && !entry.initialExecCommandActive && (entry.process.outputClosed || entry.process.outputInterrupted)) await this.captureExitedEntry(entry);
    }
  }

  /** Capacity is admission, never garbage collection: every retained row still owes output. */
  private ensureProcessCapacity(requestProcessId: number): void {
    if (this.requireDurableSpool && !this.spoolInitialized) throw UnifiedExecError.terminalStorageUnavailable();
    // Reservations participate in the hard cap, so concurrent exec_command calls cannot
    // each observe one free slot and collectively insert a 65th live process.
    if (this.reservedProcessIds.size > MAX_UNIFIED_EXEC_PROCESSES) {
      const inventory = this.inventory();
      throw UnifiedExecError.terminalCapacity(
        `limit=${MAX_UNIFIED_EXEC_PROCESSES}; reserved=${inventory.reserved}; running=${inventory.running}; ` +
        `exited_output_open=${inventory.exitedOutputOpen}; exited_output_closed=${inventory.exitedOutputClosed}; ` +
        `exited_output_interrupted=${inventory.exitedOutputInterrupted}; unread_spooled=${inventory.unreadSpooled}; completed_cache=${inventory.completedCache}; ` +
        `storage_failures=${inventory.storageFailures}; new_command_started=false`
      );
    }
    if (!this.reservedProcessIds.has(requestProcessId)) {
      throw UnifiedExecError.createProcess('terminal session reservation was lost before launch');
    }
  }
}

type ProcessStatus =
  | { kind: 'alive'; exitCode: number | null; processId: number }
  | { kind: 'exited'; exitCode: number | null }
  | { kind: 'unknown' };

/**
 * `collect_output_until_deadline`, port for port.
 *
 * The post-exit grace is the subtle part: once the process has signalled exit, the loop stops
 * waiting the full deadline and gives the output stream at most 50 ms more to close, so a
 * command that finished in 20 ms does not spend the whole 10 s yield window proving it.
 */
async function collectOutputUntilDeadline(
  process: UnifiedExecProcess,
  deadline: number,
  returnOnFirstOutput = false
): Promise<{ raw: HeadTailBuffer; display?: HeadTailBuffer }> {
  const collected = new HeadTailBuffer();
  let display: HeadTailBuffer | undefined;
  let exitSignalReceived = process.cancelled;
  let postExitDeadline: number | null = null;

  for (;;) {
    // Drained and re-armed in one synchronous step, so a chunk arriving between the two
    // cannot be missed by the wait that follows.
    const drained = process.takeBuffer();
    if (drained.display) {
      display ??= new HeadTailBuffer();
      display.pushBuffer(drained.display);
    }
    const hasDrainedOutput = drained.raw.retainedBytes() > 0 || drained.raw.omittedBytes() > 0;
    const waitForOutput = hasDrainedOutput ? null : process.outputNotify.notified();

    if (!hasDrainedOutput) {
      exitSignalReceived ||= process.cancelled;
      if (exitSignalReceived && (process.outputClosed || process.outputInterrupted)) {
        waitForOutput?.dispose();
        break;
      }
      const now = Date.now();
      const remaining = Math.max(0, deadline - now);
      if (remaining === 0) {
        waitForOutput?.dispose();
        break;
      }

      if (exitSignalReceived) {
        postExitDeadline ??= now + Math.min(remaining, POST_EXIT_CLOSE_WAIT_CAP_MS);
        const closeWaitRemaining = Math.max(0, postExitDeadline - now);
        if (closeWaitRemaining === 0) {
          waitForOutput?.dispose();
          break;
        }
        const closed = process.outputClosedNotify.notified();
        const timedOut = await raceWithTimeout([waitForOutput, closed], closeWaitRemaining);
        waitForOutput?.dispose();
        closed.dispose();
        if (timedOut) break;
        continue;
      }

      const exitNotified = process.cancelNotify.notified();
      const timedOut = await raceWithTimeout([waitForOutput, exitNotified], remaining);
      waitForOutput?.dispose();
      exitNotified.dispose();
      if (timedOut) break;
      exitSignalReceived ||= process.cancelled;
      continue;
    }

    collected.pushBuffer(drained.raw);
    if (returnOnFirstOutput) break;
    exitSignalReceived ||= process.cancelled;
    if (Date.now() >= deadline) break;
  }

  return { raw: collected, display };
}

/** Resolves true when the timeout won the race. */
async function raceWithTimeout(
  waits: ReadonlyArray<{ promise: Promise<void> } | null>,
  timeoutMs: number
): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), Math.max(0, timeoutMs));
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const races = waits.filter((wait): wait is { promise: Promise<void> } => wait !== null).map((wait) =>
      wait.promise.then(() => false)
    );
    return await Promise.race([...races, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
