export interface UpdateWorkProcess {
  processId: number;
  incarnation: number;
  pid: number;
  startedAt: number;
  owner: string;
  command: string;
}

/** Trusted desktop projection; never advertised through a model tool or Remote. */
export interface UpdateWorkSnapshot {
  processes: UpdateWorkProcess[];
  browserActions: Array<{ id: string; kind: string; error: string | null }>;
  terminalTabs: number;
  inventory?: { reserved: number; running: number; unreadSpooled: number; completedCache: number; storageFailures: number; spoolError: string | null };
  quarantined?: Array<{ processId: number; incarnation: number; command: string; completedAt: number;
    retainedBytes: number; exitCode: number | null; outputInterrupted: boolean; outputCaptureIncomplete?: boolean }>;
  quarantinedTotal?: number;
  quarantineOffset?: number;
}
