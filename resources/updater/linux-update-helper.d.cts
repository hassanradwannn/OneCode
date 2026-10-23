export interface LinuxHandoff {
  schema: 1; channel: 'stable' | 'beta'; version: string; nonce: string; digest: string;
  installation: 'appimage' | 'deb'; executable: string; userData: string; pid: number; startTicks: string; at: number;
  status: 'pending' | 'waiting-exit' | 'launching' | 'ready' | 'failed'; error?: string;
  browserUserData?: string; bridgePorts?: string;
}
export function validate(value: unknown): LinuxHandoff;
export function processIdentity(pid: number): string | null;
export function successorArguments(record: LinuxHandoff): string[];
export function successorEnvironment(record: LinuxHandoff, source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
