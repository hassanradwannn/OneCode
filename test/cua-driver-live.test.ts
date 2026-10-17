import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ safeStorage: {
  isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'unknown',
  encryptStringAsync: async (value: string) => Buffer.from(value),
  decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false })
}, clipboard: {}, shell: {} }));

// Explicit opt-in: downloads the reviewed upstream skill into a temporary profile and
// captures only the window selected by the operator. Never starts a private driver runtime.
it.skipIf(process.env.ONECODE_CUA_ACCEPTANCE !== '1')('installs Computer use against the existing daemon and captures the selected native window', async () => {
  const pid = Number(process.env.ONECODE_CUA_PID), windowId = Number(process.env.ONECODE_CUA_WINDOW);
  if (!pid || !windowId) throw new Error('Select an exact native window for CUA acceptance');
  const { findCuaDriver, cuaLaunch, downloadCuaInstaller } = await import('../src/main/plugins/cua-driver.js');
  if (!await findCuaDriver()) throw new Error('Live reuse acceptance requires an existing driver');
  const { initConfigPath } = await import('../src/main/config.js');
  const { initSecretsPath } = await import('../src/main/secrets.js');
  const { initDurableStore, flushDurable } = await import('../src/main/durable.js');
  const { initSkillsPath, listManagedSkills } = await import('../src/main/skills.js');
  const { pluginManager } = await import('../src/main/plugins/manager.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onecode-cua-live-'));
  const before = await cuaLaunch(directory);
  const session = `onecode-acceptance-${Date.now()}`;
  try {
    // Verify the actual pinned upstream installer bytes without reinstalling this device.
    expect((await fs.stat(await downloadCuaInstaller(directory))).size).toBeGreaterThan(10_000);
    initConfigPath(directory); initSecretsPath(directory); initDurableStore(directory); await initSkillsPath(directory);
    await pluginManager.initialize(directory);
    const result = await pluginManager.install({ catalogId: 'computer-use' });
    const plugin = result.plugins.find(row => row.catalogId === 'computer-use');
    expect(plugin?.status, plugin?.error).toBe('ready');
    expect(plugin?.tools.some(tool => tool.name === 'get_window_state' && tool.published)).toBe(true);
    expect((await listManagedSkills()).find(skill => skill.id === 'cua-driver')?.origin?.commit).toBe('075add55cf938f4e351b74539efa18d4976696ae');
    expect((await pluginManager.call('start_session', { session })).isError).not.toBe(true);
    const capture = await pluginManager.call('get_window_state', { session, pid, window_id: windowId, include_screenshot: true, max_elements: 20 });
    expect(capture.isError).not.toBe(true);
    expect(capture.content.some(block => block.type === 'image')).toBe(true);
    await pluginManager.call('end_session', { session });
    await pluginManager.close();
    expect((await cuaLaunch(directory)).args).toEqual(before.args);
  } finally {
    await pluginManager.close(); await flushDurable();
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 180_000);
