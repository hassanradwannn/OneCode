/** Real pinned NSIS downloader, real blockmaps/cache and HTTP Range; no installer execution. */
import { createServer, type RequestOptions } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { NsisUpdater, CancellationToken } from 'electron-updater';
import { NodeHttpExecutor } from 'builder-util/out/nodeHttpExecutor.js';
import { configureRequestUrl, type DownloadOptions } from 'builder-util-runtime';
import type { AppAdapter } from 'electron-updater/out/AppAdapter.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { configureWindowsDownloadEngine } from '../src/main/update-download.js';

class TestTransport extends NodeHttpExecutor {
  download(url: URL, destination: string, options: DownloadOptions & { cancellationToken: CancellationToken }): Promise<string> {
    return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
      const request: RequestOptions = { headers: options.headers ?? undefined };
      configureRequestUrl(url, request);
      this.doDownload(request, { destination, options, onCancel, responseHandler: null,
        callback: error => error ? reject(error) : resolve(destination) }, 0);
    });
  }
}
const digest = (bytes: Buffer) => createHash('sha512').update(bytes).digest('base64');
const blockmap = (blocks: Buffer[]) => ({ version: '2', files: [{ name: 'file', offset: 0,
  sizes: blocks.map(block => block.length), checksums: blocks.map(block => createHash('sha256').update(block).digest('base64')) }] });

it.each([true, false])('downloads a verified installer with old blockmap available=%s; normal Quit has no install hook', async hasOldMap => {
  const directory = await makeTempDir('onecode-real-differential-');
  const old = [Buffer.alloc(65536, 17), Buffer.alloc(65536, 23), Buffer.alloc(65536, 41)];
  const next = [old[0]!, Buffer.alloc(65536, 67), old[2]!];
  const body = Buffer.concat(next);
  const requests: Array<{ path: string; range: string | null; bytes: number }> = [];
  const file = `OneCode-Setup-${process.arch}.exe`;
  const server = createServer((request, response) => {
    const route = new URL(request.url!, 'http://localhost').pathname;
    let bytes: Buffer;
    if (route.endsWith('.yml')) bytes = Buffer.from(`version: 99.0.0\nfiles:\n  - url: ${file}\n    sha512: ${digest(body)}\n    size: ${body.length}\n`);
    else if (route === `/v99.0.0/${file}.blockmap`) bytes = gzipSync(JSON.stringify(blockmap(next)));
    else if (route === `/v0.2.6/${file}.blockmap` && hasOldMap) bytes = gzipSync(JSON.stringify(blockmap(old)));
    else if (route === `/v99.0.0/${file}`) bytes = body;
    else { response.writeHead(404); response.end(); return; }
    const range = request.headers.range ?? null;
    if (range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const start = Number(match[1]), end = Number(match[2]);
      response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': end - start + 1 });
      bytes = bytes.subarray(start, end + 1);
    } else response.writeHead(200, { 'content-length': bytes.length });
    requests.push({ path: route, range, bytes: bytes.length }); response.end(bytes);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const cache = path.join(directory, 'cache with spaces');
    await mkdir(path.join(cache, 'onecode-updater'), { recursive: true });
    await writeFile(path.join(cache, 'onecode-updater', 'installer.exe'), Buffer.concat(old));
    const config = path.join(directory, 'app-update.yml');
    await writeFile(config, 'updaterCacheDirName: onecode-updater\n');
    const onQuit = vi.fn(), quit = vi.fn();
    const adapter: AppAdapter = { version: '0.2.6', name: 'OneCode', isPackaged: true, userDataPath: directory,
      baseCachePath: cache, appUpdateConfigPath: config, whenReady: async () => undefined, relaunch: vi.fn(), quit, onQuit };
    const updater = new NsisUpdater(null, adapter);
    Object.defineProperty(updater, 'httpExecutor', { value: new TestTransport() });
    configureWindowsDownloadEngine(updater);
    updater.logger = null; updater.on('error', () => undefined);
    updater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${port}/v99.0.0/`, useMultipleRangeRequest: false });
    expect((await updater.checkForUpdates())?.updateInfo.version).toBe('99.0.0');
    expect(requests.some(row => row.path.endsWith('.exe'))).toBe(false); // autoDownload is off
    const downloaded = await updater.downloadUpdate();
    expect(await readFile(downloaded[0]!)).toEqual(body);
    const installerRequests = requests.filter(row => row.path.endsWith('.exe'));
    expect(installerRequests).toHaveLength(1);
    if (hasOldMap) {
      expect(installerRequests[0]).toMatchObject({ range: 'bytes=65536-131071', bytes: 65536 });
      expect(installerRequests[0]!.bytes).toBeLessThan(body.length);
    } else expect(installerRequests[0]).toMatchObject({ range: null, bytes: body.length });
    expect(onQuit).not.toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
    expect(await readFile(path.join(cache, 'onecode-updater', 'installer.exe'))).toEqual(Buffer.concat(old));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await removeTempDir(directory);
  }
}, 30000);
