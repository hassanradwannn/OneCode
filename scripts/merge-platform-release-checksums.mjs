import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const [directoryArg, assetsArg = 'assets.json'] = process.argv.slice(2);
if (!directoryArg) throw new Error('Supply the directory containing both platform checksum sidecars.');

const directory = path.resolve(directoryArg);
const assetsPath = path.resolve(directory, assetsArg);
const sidecarNames = ['SHA256SUMS-win32-x64.txt', 'SHA256SUMS-linux-x64.txt'];
const canonicalName = 'SHA256SUMS.txt';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parse(text, label) {
  const rows = new Map();
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._+-]*)$/u);
    if (!match || match[2].includes('..') || rows.has(match[2])) throw new Error(`Invalid or duplicate checksum row in ${label}.`);
    rows.set(match[2], match[1]);
  }
  if (!rows.size) throw new Error(`No checksum rows in ${label}.`);
  return rows;
}

const assetsDocument = JSON.parse((await fs.readFile(assetsPath, 'utf8')).replace(/^\uFEFF/u, ''));
const assets = Array.isArray(assetsDocument) ? assetsDocument : assetsDocument.assets;
if (!Array.isArray(assets)) throw new Error('assets.json does not contain a GitHub release asset list.');
const byName = new Map(assets.map(asset => [asset.name, asset]));

const merged = new Map();
for (const name of sidecarNames) {
  const bytes = await fs.readFile(path.join(directory, name));
  const remote = byName.get(name);
  if (!remote || remote.digest !== `sha256:${sha256(bytes)}`) throw new Error(`GitHub digest mismatch for ${name}.`);
  for (const [payload, digest] of parse(bytes.toString('utf8'), name)) {
    const previous = merged.get(payload);
    if (previous && previous !== digest) throw new Error(`Platform checksum conflict for ${payload}.`);
    merged.set(payload, digest);
  }
}

const ignored = new Set([...sidecarNames, canonicalName]);
const payloads = assets.filter(asset => !ignored.has(asset.name));
if (payloads.length !== merged.size) throw new Error('Platform sidecars do not cover the complete draft payload inventory.');
for (const asset of payloads) {
  const digest = merged.get(asset.name);
  if (!digest || asset.digest !== `sha256:${digest}`) throw new Error(`Canonical checksum would not match GitHub asset ${asset.name}.`);
}

const canonicalText = [...merged].sort(([a], [b]) => a.localeCompare(b)).map(([name, digest]) => `${digest}  ${name}`).join('\n') + '\n';
const canonicalBytes = Buffer.from(canonicalText, 'utf8');
const canonicalDigest = sha256(canonicalBytes);
const existing = byName.get(canonicalName);
if (existing && (existing.size !== canonicalBytes.length || existing.digest !== `sha256:${canonicalDigest}`)) {
  throw new Error('Release already contains a different SHA256SUMS.txt; refusing replacement.');
}

await fs.writeFile(path.join(directory, canonicalName), canonicalBytes, { flag: 'w' });
console.log(JSON.stringify({ rows: merged.size, bytes: canonicalBytes.length, sha256: canonicalDigest, alreadyPresent: Boolean(existing) }));
