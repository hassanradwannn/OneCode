/** One app-spawned exec_command child that is still running in the local process manager. */
export interface RunningExecProcess {
  processId: number;
  /** App-lifetime generation that fences a recycled numeric process id at action time. */
  incarnation: number;
  command: string;
  startedAt: number;
  tty: boolean;
  /** Present when this exec also owns token-tagged descendants in one or more WSL distros. */
  detachedWsl?: true;
  /** Custody state for tagged WSL processes; unknown means termination could not be verified. */
  terminationState?: 'pending' | 'tagged' | 'termination-unknown';
}
