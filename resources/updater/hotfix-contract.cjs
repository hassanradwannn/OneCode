'use strict';
// Shared by packaging, the desktop update owner and the detached Windows helper.
const path = require('node:path');
const crypto = require('node:crypto');
const HEX = /^[a-f0-9]{64}$/;
function withFilesystem(fs) {
function relative(name) {
  return typeof name === 'string' && name.length < 240 && /^[A-Za-z0-9@_+./ -]+$/.test(name) &&
    name.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function mutable(name, platform = 'win32') {
  return relative(name) && (['app.asar', 'THIRD-PARTY-NOTICES.txt'].includes(name) ||
    (platform === 'win32' && name === 'WINDOWS-SETUP.md') ||
    name.startsWith('extension/') || name.startsWith('skills/') || /^updater\/[A-Za-z0-9_-]+\.cjs$/.test(name));
}
function noLinks(file) {
  for (let item = path.resolve(file); ; item = path.dirname(item)) {
    if (fs.lstatSync(item, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('Hotfix paths must not redirect');
    if (path.dirname(item) === item) break;
  }
}
function location(root, name) {
  if (!relative(name)) throw Error('Invalid hotfix relative path');
  const result = path.resolve(root, ...name.split('/'));
  if (!result.startsWith(path.resolve(root) + path.sep)) throw Error('Hotfix path escaped its owner');
  noLinks(result); return result;
}
async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function inventory(root, predicate = () => true, prefix = '') {
  noLinks(path.join(root, prefix));
  const names = [];
  function visit(current) {
    for (const item of fs.readdirSync(path.join(root, current), { withFileTypes: true })) {
      const name = current + item.name;
      if (!relative(name) || item.isSymbolicLink()) throw Error('Unsafe packaged resource');
      if (item.isDirectory()) visit(name + '/'); else if (predicate(name)) names.push(name);
    }
  }
  visit(prefix);
  const files = await parallel(names, async name => {
    const file = path.join(root, ...name.split('/')), stat = fs.lstatSync(file);
    if (!stat.isFile()) throw Error('Unsafe packaged resource');
    return { path: name, size: stat.size, sha256: await hash(file) };
  });
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
async function parallel(items, operation) {
  const results = new Array(items.length); let cursor = 0, failure;
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (!failure && cursor < items.length) {
      const index = cursor++;
      try { results[index] = await operation(items[index]); } catch (error) { failure = error; }
    }
  }));
  if (failure) throw failure; return results;
}
function entries(files, payload, platform = 'win32') {
  if (!Array.isArray(files) || files.length < 1 || files.length > (payload ? 512 : 10000)) throw Error('Invalid hotfix inventory');
  const seen = new Set(); let total = 0;
  for (const file of files) {
    if (!relative(file.path) || (payload ? !mutable(file.path, platform) : mutable(file.path, platform) || file.path === 'updater/runtime.json') ||
        !HEX.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 192 * 1024 * 1024 || seen.has(file.path.toLowerCase())) throw Error('Invalid hotfix file');
    seen.add(file.path.toLowerCase()); total += file.size;
  }
  if (payload && (total > 256 * 1024 * 1024 || !seen.has('app.asar'))) throw Error('Invalid hotfix payload size');
}
function runtimeId(...args) {
  const legacy = args.length === 3;
  const [platform, arch, files, electron, loader, channel = 'stable'] = legacy ? ['win32', ...args] : args;
  const value = { platform, arch, electron, files, ...(loader ? { loader } : {}), ...(channel === 'beta' ? { channel } : {}) };
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function runtime(value) {
  const windows = value?.schema === 1 && value.platform === 'win32';
  const linux = value?.schema === 2 && value.platform === 'linux' && HEX.test(value.loader);
  if ((!windows && !linux) || !['x64','arm64'].includes(value.arch) || !/^\d+\.\d+\.\d+$/.test(value.electron)) throw Error('Invalid hotfix runtime');
  entries(value.files, false, value.platform);
  if(value.baseVersion!==undefined && (typeof value.baseVersion!=='string' || !/^\d+\.\d+\.\d+$/.test(value.baseVersion))) throw Error('Invalid installed base version');
  if(linux && !value.baseVersion) throw Error('Linux hotfix runtime must name its complete base');
  const channel = value.channel ?? 'stable';
  if (!['stable', 'beta'].includes(channel)) throw Error('Invalid hotfix channel');
  const expected = windows
    ? channel === 'beta' ? runtimeId('win32', value.arch, value.files, value.electron, undefined, channel) : runtimeId(value.arch, value.files, value.electron)
    : runtimeId(value.platform, value.arch, value.files, value.electron, value.loader, channel);
  if (value.id !== expected) throw Error('Hotfix runtime fingerprint changed');
  return value;
}
function compatibleBase(runtime,manifest) {
  if ((runtime.channel ?? 'stable') !== (manifest.channel ?? 'stable')) return false;
  if(runtime.id!==manifest.runtime || runtime.arch!==manifest.arch || runtime.platform!==manifest.platform) return false;
  if(!manifest.base) return true;
  if(!runtime.baseVersion) return false;
  const installed=runtime.baseVersion.split('.').map(Number),needed=manifest.base.version.split('.').map(Number);
  for(let i=0;i<3;i++)if(installed[i]!==needed[i])return installed[i]>needed[i];
  return true;
}
function manifest(value) {
  const channel = value?.channel ?? 'stable', prefix = channel === 'beta' ? 'OneCode-Beta-' : 'OneCode-';
  const windows = value?.schema === 1 && value.platform === 'win32' && value.archive === `${prefix}Hotfix-${value.arch}.zip`;
  const linux = value?.schema === 2 && value.platform === 'linux' && value.archive === `${prefix}Linux-Hotfix-${value.arch}.zip`;
  if (!['stable','beta'].includes(channel) || (!windows && !linux) || !/^\d+\.\d+\.\d+$/.test(value.version) || !['x64','arm64'].includes(value.arch) ||
      !HEX.test(value.runtime) || !HEX.test(value.sha256) ||
      !Number.isSafeInteger(value.size) || value.size < 1 || value.size > 64 * 1024 * 1024) throw Error('Invalid hotfix manifest');
  entries(value.files, true, value.platform);
  if (value.base !== undefined) {
    baseRelease(value.base);
    const compare = (a,b) => { const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];return 0; };
    if(value.base.platform!==value.platform || value.base.arch!==value.arch || value.base.runtime!==value.runtime || (value.base.channel ?? 'stable') !== channel || compare(value.base.version,value.version)>0) throw Error('Hotfix base differs from its platform, runtime, channel or release');
  }
  return value;
}
function baseRelease(value) {
  const channel=value?.channel ?? 'stable',prefix=channel==='beta'?'OneCode-Beta-':'OneCode-';
  const windows = value?.schema===1 && value.platform==='win32' && value.installer===`${prefix}Setup-${value.arch}.exe`;
  const linux = value?.schema===2 && value.platform==='linux' && value.installer===`${prefix}Linux-${value.arch}.AppImage`;
  const expectedTag=channel==='beta'?`beta-v${value?.version}`:`v${value?.version}`;
  if(!['stable','beta'].includes(channel) || (value.tag!==undefined && value.tag!==expectedTag) || (channel==='beta' && value.tag!==expectedTag) || (!windows && !linux) || !/^\d+\.\d+\.\d+$/.test(value.version) || !['x64','arm64'].includes(value.arch) ||
    !HEX.test(value.runtime) || !HEX.test(value.sha256) || !Number.isSafeInteger(value.size) || value.size<1 || value.size>1024*1024*1024) throw Error('Invalid full release descriptor');
  return value;
}
async function verify(root, files) {
  noLinks(root); const directories = new Set();
  await parallel(files, async file => {
    if (!relative(file.path)) throw Error('Invalid hotfix relative path');
    const resolved = path.join(root, ...file.path.split('/')), parent = path.dirname(resolved);
    if (!directories.has(parent)) { noLinks(parent); directories.add(parent); }
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.size !== file.size || await hash(resolved) !== file.sha256) throw Error('Hotfix resource does not match its verified inventory');
  });
}
return { mutable, noLinks, location, hash, inventory, runtimeId, runtime, manifest, baseRelease, compatibleBase, verify };
}
module.exports = { ...withFilesystem(require('node:fs')), withFilesystem };
