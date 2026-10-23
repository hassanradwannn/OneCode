import { performance } from 'node:perf_hooks';

const SAMPLE_MS = 10_000;
let timer: ReturnType<typeof setInterval> | null = null;
let previous = performance.now();
let utilization = performance.eventLoopUtilization();
let lastDelayMs: number | null = null, maximumDelayMs = 0, lastSampleAt: number | null = null;
let suspended = false, resumes = 0;

/** Diagnostic sampling never drives recovery, revokes authority or dispatches work. */
export function startRuntimeHealth(): void {
  if (timer) return;
  previous = performance.now(); utilization = performance.eventLoopUtilization();
  timer = setInterval(() => {
    const now = performance.now();
    if (!suspended) {
      lastDelayMs = Math.max(0, Math.round(now - previous - SAMPLE_MS));
      maximumDelayMs = Math.max(maximumDelayMs, lastDelayMs);
      lastSampleAt = Date.now();
    }
    previous = now;
  }, SAMPLE_MS);
  timer.unref();
}
export function runtimeSuspended(): void { suspended = true; }
export function runtimeResumed(): void {
  suspended = false; resumes++; previous = performance.now();
  lastDelayMs = null; utilization = performance.eventLoopUtilization();
}
export function runtimeHealthSnapshot() {
  const current = performance.eventLoopUtilization(), delta = performance.eventLoopUtilization(current, utilization);
  utilization = current;
  const memory = process.memoryUsage();
  return { suspended, resumes, lastSampleAt, lastDelayMs, maximumDelayMs,
    eventLoopUtilization: Math.round(delta.utilization * 1000) / 1000,
    rssBytes: memory.rss, heapUsedBytes: memory.heapUsed };
}
