export interface FileEntry { path: string; size: number; sha256: string }
export interface Runtime { schema: 1; platform: 'win32'; arch: 'x64' | 'arm64'; electron: string; id: string; files: FileEntry[]; baseVersion?: string }
export function compatibleBase(runtime: Runtime, manifest: Manifest): boolean;
export interface BaseRelease { schema: 1; version: string; platform: 'win32'; arch: 'x64' | 'arm64'; runtime: string; installer: string; sha256: string; size: number }
export interface Manifest { schema: 1; version: string; platform: 'win32'; arch: 'x64' | 'arm64'; runtime: string; archive: string; sha256: string; size: number; files: FileEntry[]; base?: BaseRelease }
export function baseRelease(value: unknown): BaseRelease;
export function mutable(name: string): boolean;
export function noLinks(file: string): void;
export function location(root: string, name: string): string;
export function hash(file: string): Promise<string>;
export function inventory(root: string, predicate?: (name: string) => boolean, prefix?: string): Promise<FileEntry[]>;
export function runtimeId(arch: string, files: FileEntry[], electron: string): string;
export function runtime(value: unknown): Runtime;
export function manifest(value: unknown): Manifest;
export function verify(root: string, files: FileEntry[]): Promise<void>;
export function withFilesystem(fs: typeof import('node:fs')): Omit<typeof import('./hotfix-contract.cjs'), 'withFilesystem'>;
