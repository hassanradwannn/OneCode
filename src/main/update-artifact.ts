/** Resumable transport only. Published SHA-256 remains the install authority. */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function receiveUpdateArtifact(options: {
  file: string; name: string; expected: string; size?: number; stallMs: number;
  fetch(signal: AbortSignal, headers: Record<string, string>): Promise<Response>;
  progress?(bytes: number, total?: number): void;
}): Promise<string> {
  const part = `${options.file}.part`;
  let received = 0, hash = createHash('sha256');
  try {
    const saved = await lstat(part);
    if (!saved.isFile() || saved.isSymbolicLink()) throw new Error('Update partial file must be a regular file');
    if (options.size !== undefined && saved.size > options.size) await rm(part);
    else {
      for await (const chunk of createReadStream(part)) { hash.update(chunk); received += chunk.length; }
      if (hash.copy().digest('hex') === options.expected && (options.size === undefined || received === options.size)) {
        await rename(part, options.file); options.progress?.(received, options.size); return options.file;
      }
      if (options.size !== undefined && received === options.size) { await rm(part); received = 0; hash = createHash('sha256'); }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  const quiet = new AbortController();
  const stalled = new Error(`downloading ${options.name} stopped: no data for ${options.stallMs / 1000} seconds; partial download retained`);
  const watch = setTimeout(() => quiet.abort(stalled), options.stallMs);
  let total = options.size;
  try {
    let response: Response;
    try { response = await options.fetch(quiet.signal, { 'accept-encoding': 'identity', ...(received ? { Range: `bytes=${received}-` } : {}) }); }
    catch (error) {
      if (!received || (error as { status?: number }).status !== 416) throw error;
      await rm(part, { force: true }); received = 0; hash = createHash('sha256');
      response = await options.fetch(quiet.signal, { 'accept-encoding': 'identity' });
    }
    if (!response.body) throw new Error(`downloading ${options.name} returned no content`);
    if (response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      const [start, end, length] = range ? range.slice(1).map(Number) : [];
      if (!range || ![start, end, length].every(Number.isSafeInteger) || start !== received || end! < start! || end! >= length! ||
          (options.size !== undefined && length !== options.size)) {
        await response.body.cancel().catch(() => undefined);
        throw new Error('The update server returned an invalid resume range');
      }
      total ??= length;
    } else if (response.status === 200) {
      // A server may ignore Range. Replace from byte zero, never append a second full file.
      received = 0; hash = createHash('sha256');
      const length = Number(response.headers.get('content-length'));
      if (total === undefined && Number.isSafeInteger(length) && length > 0) total = length;
    } else {
      await response.body.cancel().catch(() => undefined);
      throw new Error(`downloading ${options.name} answered ${response.status}`);
    }
    options.progress?.(received, total);
    const append = received > 0;
    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on('data', (chunk: Buffer) => { received += chunk.length; hash.update(chunk); watch.refresh(); options.progress?.(received, total); });
    await pipeline(body, createWriteStream(part, { flags: append ? 'a' : 'w' }), { signal: quiet.signal });
    if (total !== undefined && received < total && hash.copy().digest('hex') !== options.expected)
      throw new Error(`downloading ${options.name} was interrupted; partial download retained`);
  } catch (error) {
    // Retain bytes after network interruption/restart. The next attempt hashes the
    // entire prefix again, validates Range and still verifies the completed digest.
    throw quiet.signal.aborted ? stalled : error;
  } finally { clearTimeout(watch); }
  const digest = hash.digest('hex');
  if (digest !== options.expected || (options.size !== undefined && received !== options.size)) {
    await rm(part, { force: true });
    throw new Error(`${options.name} is not the published file: sha256 ${digest} instead of ${options.expected}`);
  }
  await rename(part, options.file);
  return options.file;
}
