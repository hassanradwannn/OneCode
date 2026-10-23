export interface FileEntry { path: string; size: number; sha256: string }
export interface WindowsRuntime { schema: 1; platform: 'win32'; arch: 'x64' | 'arm64'; electron: string; id: string; files: FileEntry[]; baseVersion?: string; channel?: 'stable' | 'beta' }
export interface LinuxRuntime { schema: 2; platform: 'linux'; arch: 'x64' | 'arm64'; electron: string; loader: string; id: string; files: FileEntry[]; baseVersion?: string; channel?: 'stable' | 'beta' }
export type Runtime = WindowsRuntime | LinuxRuntime;
export function compatibleBase(runtime: Runtime, manifest: Manifest): boolean;
export interface WindowsBaseRelease { schema: 1; version: string; platform: 'win32'; arch: 'x64' | 'arm64'; runtime: string; installer: string; sha256: string; size: number; channel?: 'stable' | 'beta'; tag?: string }
export interface LinuxBaseRelease { schema: 2; version: string; platform: 'linux'; arch: 'x64' | 'arm64'; runtime: string; installer: string; sha256: string; size: number; channel?: 'stable' | 'beta'; tag?: string }
export type BaseRelease = WindowsBaseRelease | LinuxBaseRelease;
export interface WindowsManifest { schema: 1; version: string; platform: 'win32'; arch: 'x64' | 'arm64'; runtime: string; archive: string; sha256: string; size: number; files: FileEntry[]; base?: WindowsBaseRelease; channel?: 'stable' | 'beta' }
export interface LinuxManifest { schema: 2; version: string; platform: 'linux'; arch: 'x64' | 'arm64'; runtime: string; archive: string; sha256: string; size: number; files: FileEntry[]; base?: LinuxBaseRelease; channel?: 'stable' | 'beta' }
export type Manifest = WindowsManifest | LinuxManifest;
export function baseRelease(value: unknown): BaseRelease;
export function mutable(name: string, platform?: 'win32' | 'linux'): boolean;
export function noLinks(file: string): void;
export function location(root: string, name: string): string;
export function hash(file: string): Promise<string>;
export function inventory(root: string, predicate?: (name: string) => boolean, prefix?: string): Promise<FileEntry[]>;
export function runtimeId(arch: string, files: FileEntry[], electron: string): string;
export function runtimeId(platform: 'linux', arch: string, files: FileEntry[], electron: string, loader: string, channel?: 'stable' | 'beta'): string;
export function runtime(value: unknown): Runtime;
export function manifest(value: unknown): Manifest;
export function verify(root: string, files: FileEntry[]): Promise<void>;
export function withFilesystem(fs: typeof import('node:fs')): Omit<typeof import('./hotfix-contract.cjs'), 'withFilesystem'>;
