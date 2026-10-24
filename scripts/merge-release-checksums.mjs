import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const [fullFile, capsuleFile, outputFile] = process.argv.slice(2);
if (!fullFile || !capsuleFile || !outputFile) throw new Error('Supply full, capsule and output checksum files');

function parse(text, label) {
  const rows = new Map();
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._+-]*)$/u);
    if (!match || match[2].includes('..')) throw new Error(`Invalid checksum row in ${label}`);
    const previous = rows.get(match[2]);
    if (previous && previous !== match[1]) throw new Error(`Conflicting checksum for ${match[2]}`);
    rows.set(match[2], match[1]);
  }
  if (!rows.size) throw new Error(`No checksum rows in ${label}`);
  return rows;
}

const full = parse(await fs.readFile(fullFile, 'utf8'), 'full release');
const capsule = parse(await fs.readFile(capsuleFile, 'utf8'), 'capsule');
const merged = new Map(full);
for (const [name, digest] of capsule) {
  const previous = merged.get(name);
  if (previous && previous !== digest) throw new Error(`Full/capsule checksum conflict for ${name}`);
  merged.set(name, digest);
}

const directory = path.dirname(path.resolve(outputFile));
for (const [name, digest] of merged) {
  const bytes = await fs.readFile(path.join(directory, name));
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error(`Release file differs from merged checksum: ${name}`);
}

const rows = [...merged].sort(([a], [b]) => a.localeCompare(b)).map(([name, digest]) => `${digest}  ${name}`);
await fs.writeFile(outputFile, rows.join('\n') + '\n', 'utf8');
console.log(`Merged ${full.size} full-release rows and ${capsule.size} capsule rows into ${merged.size} verified rows.`);
