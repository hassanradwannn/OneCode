import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ execute: vi.fn(), spawn: vi.fn(), install: vi.fn() }));
vi.mock('../src/main/plugins/installer.js', () => ({ pluginEnvironment: () => ({}), runInstaller: mock.install }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: mock.execute }), spawn: mock.spawn };
});
const { cuaCandidates, cuaSocket, cuaLaunch, downloadCuaInstaller } = await import('../src/main/plugins/cua-driver.js');
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
describe('Computer use upstream integration', () => {
  it('discovers current and legacy Windows installations without requiring a fresh shell PATH', () => {
    const paths = cuaCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', PATH: 'C:\\bin' }, 'C:\\Users\\test');
    expect(paths).toContain('C:\\Users\\test\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe');
    expect(paths).toContain('C:\\Users\\test\\AppData\\Local\\Programs\\trycua\\cua-driver-rs\\bin\\cua-driver.exe');
    expect(paths).toContain('C:\\bin\\cua-driver.exe');
    expect(() => cuaCandidates('win32', { CUA_DRIVER_PATH: 'relative.exe' })).toThrow('absolute');
  });
  it('recognizes only a running daemon with an explicit endpoint', () => {
    expect(cuaSocket('Cua Driver daemon is running\n  socket: \\\\.\\pipe\\cua-driver\n  pid: 123')).toBe('\\\\.\\pipe\\cua-driver');
    expect(cuaSocket('Cua Driver daemon is not running')).toBeNull();
    expect(() => cuaSocket('Cua Driver daemon is running\n')).toThrow('endpoint');
  });
  it('reuses the existing daemon through an explicit MCP proxy and preserves its installed version', async () => {
    vi.spyOn(fs, 'stat').mockResolvedValue({ isFile: () => true } as any);
    mock.execute.mockImplementation(async (_command, args) => ({ stdout: args[0] === 'status'
      ? 'Cua Driver daemon is running\n  socket: \\\\.\\pipe\\cua-driver\n  pid: 123'
      : 'cua-driver 0.35.9' }));
    const [a, b] = await Promise.all([cuaLaunch('unused', true), cuaLaunch('unused', true)]);
    expect(a).toEqual(b); expect(a.args).toEqual(['mcp', '--socket', '\\\\.\\pipe\\cua-driver']);
    expect(a.version).toBe('0.35.9'); expect(mock.install).not.toHaveBeenCalled(); expect(mock.spawn).not.toHaveBeenCalled();
    expect(mock.execute.mock.calls.map(call => call[1])).toEqual([['status'], ['--version']]);
  });
  it('does not install missing software during an ordinary reconnect', async () => {
    vi.spyOn(fs, 'stat').mockRejectedValue(new Error('ENOENT'));
    await expect(cuaLaunch('unused')).rejects.toThrow('missing');
    expect(mock.install).not.toHaveBeenCalled(); expect(mock.spawn).not.toHaveBeenCalled();
  });
  it('refuses altered or oversized upstream installers before writing or running them', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cua-recipe-'));
    try {
      const altered = vi.fn(async () => new Response('untrusted installer'));
      await expect(downloadCuaInstaller(dir, 'win32', altered as typeof fetch)).rejects.toThrow('checksum');
      const oversized = vi.fn(async () => new Response(new Uint8Array(256_001)));
      await expect(downloadCuaInstaller(dir, 'win32', oversized as typeof fetch)).rejects.toThrow('size limit');
      expect(await fs.readdir(dir)).toEqual([]); expect(mock.install).not.toHaveBeenCalled();
      expect(altered.mock.calls).toHaveLength(1);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
