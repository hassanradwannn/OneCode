import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const OWNER = 'hassanradwannn';
const REPOSITORY = 'OneCode';
const API = `https://api.github.com/repos/${OWNER}/${REPOSITORY}`;
const operation = process.argv[2];
const env = process.env;
const source = path.resolve(env.APP_SOURCE_DIR || '.');
const sourceRef = (env.SOURCE_REF || '').toLowerCase();
const tag = env.RELEASE_TAG || '';
const selectedOperation = env.BUILD_OPERATION || '';
const platform = env.BUILD_PLATFORM || '';
const baseVersion = env.BASE_VERSION || '';
const arch = 'x64';

function fail(message) {
  throw new Error(message);
}

function validateInputs() {
  if (!['verify', 'stage', 'upload'].includes(operation)) fail('Choose verify, stage, or upload.');
  if (!/^[0-9a-f]{40}$/.test(sourceRef)) fail('source_ref must be an exact 40 character commit SHA.');
  if (!['beta-full', 'beta-capsule', 'stable-full', 'stable-capsule', 'stable-release', 'stable-full-backfill'].includes(selectedOperation)) fail('Unsupported app build operation.');
  if (!['win32', 'linux'].includes(platform)) fail('Only Windows x64 and Linux x64 are supported.');
  if (selectedOperation === 'beta-capsule' || selectedOperation === 'stable-capsule' || selectedOperation === 'stable-release') {
    if (!/^\d+\.\d+\.\d+$/.test(baseVersion)) fail('Capsule operations require base_version in X.Y.Z form.');
  } else if (baseVersion) {
    fail('base_version is only valid for capsule operations.');
  }
}

function channelFor(op = selectedOperation) {
  return op === 'stable-full' || op === 'stable-capsule' || op === 'stable-release' || op === 'stable-full-backfill' ? 'stable' : 'beta';
}

function outputDirectory() {
  return path.join(source, channelFor() === 'beta' ? 'release-beta' : 'release');
}

function sourceMetadata() {
  const pkgJson = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
  const pkg = pkgJson.version;
  if (!/^\d+\.\d+\.\d+$/.test(pkg)) fail('package.json version is invalid.');
  const extension = JSON.parse(readFileSync(path.join(source, 'extension/manifest.json'), 'utf8'));
  const versionText = readFileSync(path.join(source, 'src/main/version.ts'), 'utf8');
  const appVersion = versionText.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/u)?.[1];
  if (extension.version !== pkg || appVersion !== pkg) fail('The source version owners do not agree.');
  const expectedChannel = channelFor();
  const expectedTag = expectedChannel === 'beta' ? `beta-v${pkg}` : `v${pkg}`;
  if (tag !== expectedTag) fail(`release_tag must be ${expectedTag} for this source version and operation.`);
  const currentSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim().toLowerCase();
  if (currentSha !== sourceRef) fail('Checked out source does not match source_ref.');
  return { version: pkg, channel: expectedChannel, tag: expectedTag, sha: currentSha };
}

async function github(pathname, token, options = {}) {
  const response = await fetch(`${API}${pathname}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'onecode-draft-app-build',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) fail(`GitHub API request failed (${response.status}) for ${pathname}.`);
  return response.status === 204 ? null : response.json();
}

async function tagCommit(tagName, token) {
  let ref = await github(`/git/ref/tags/${encodeURIComponent(tagName)}`, token);
  let object = ref.object;
  for (let depth = 0; depth < 5; depth++) {
    if (object.type === 'commit') return object.sha.toLowerCase();
    if (object.type !== 'tag') fail(`Git tag ${tagName} does not resolve to a commit.`);
    const annotated = await github(`/git/tags/${object.sha}`, token);
    object = annotated.object;
  }
  fail(`Git tag ${tagName} has too many annotated tag layers.`);
}

async function getRelease(tagName, token) {
  // The by-tag endpoint exposes published releases only. List with the authenticated
  // draft owner's token and require one exact tag before granting any upload.
  const matches = [];
  for (let page = 1; page <= 10; page++) {
    const releases = await github(`/releases?per_page=100&page=${page}`, token);
    matches.push(...releases.filter(release => release.tag_name === tagName));
    if (releases.length < 100) {
      if (matches.length !== 1) fail(`Expected one accessible release for ${tagName}.`);
      return matches[0];
    }
  }
  fail('Release inventory exceeds the bounded draft lookup.');
}

async function verifyReleaseTarget(token, metadata) {
  const release = await getRelease(metadata.tag, token);
  const publishedBackfill = selectedOperation === 'stable-full-backfill';
  if (publishedBackfill) {
    if (release.tag_name !== metadata.tag || release.draft !== false || !release.published_at || release.prerelease !== false) {
      fail('Stable full backfill requires the exact already-published stable release.');
    }
  } else if (release.tag_name !== metadata.tag || release.draft !== true || release.published_at !== null || release.prerelease !== (metadata.channel === 'beta')) {
    fail('The requested release must still be an unpublished draft with the exact tag.');
  }
  if (await tagCommit(metadata.tag, token) !== metadata.sha) fail('The release tag no longer points at source_ref.');
  if (selectedOperation === 'beta-capsule' || selectedOperation === 'stable-capsule' || selectedOperation === 'stable-release') {
    const compare = (left, right) => {
      const a = left.split('.').map(Number), b = right.split('.').map(Number);
      for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
      return 0;
    };
    if (compare(baseVersion, metadata.version) >= 0) fail('base_version must be older than the capsule version.');
    const baseTag = metadata.channel === 'beta' ? `beta-v${baseVersion}` : `v${baseVersion}`;
    const base = await getRelease(baseTag, token);
    if (base.draft !== false || !base.published_at || base.tag_name !== baseTag || base.prerelease !== (metadata.channel === 'beta')) {
      fail('The capsule base must be an already published release on the selected channel.');
    }
  }
  return release;
}

function expectedNames({ version, channel, op = selectedOperation }) {
  const prefix = channel === 'beta' ? 'OneCode-Beta' : 'OneCode';
  if (op === 'beta-capsule' || op === 'stable-capsule') {
    return platform === 'win32'
      ? [`${prefix}-Hotfix-x64.zip`, `${prefix}-Hotfix-x64.json`]
      : [`${prefix}-Linux-Hotfix-x64.zip`, `${prefix}-Linux-Hotfix-x64.json`];
  }
  if (platform === 'linux') {
    const full = [`${prefix}-Linux-x64.AppImage`, `${prefix}-Linux-x64.deb`, `${prefix}-Linux-Base-x64.json`];
    return op === 'stable-full' || op === 'stable-release' ? [...full, `${prefix}-Linux-Hotfix-x64.zip`, `${prefix}-Linux-Hotfix-x64.json`] : full;
  }
  const full = [
    `${prefix}-Setup-x64.exe`, `${prefix}-Setup-x64.exe.blockmap`,
    `${channel === 'beta' ? 'beta-latest' : 'latest'}-x64.yml`,
    `${prefix}-Companion-${version}.zip`, 'OneCode-Gemini-Skill.zip', 'OneCode-ChatGPT-Skill.zip',
    'SKILL.md', 'WINDOWS-SETUP.md', 'MULTI-PROVIDER-COMPATIBILITY.md', `${prefix}-Base-x64.json`
  ];
  return op === 'stable-full' || op === 'stable-release' ? [...full, 'OneCode-Hotfix-x64.zip', 'OneCode-Hotfix-x64.json'] : full;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function checksumRows(dir) {
  const raw = await fs.readFile(path.join(dir, 'SHA256SUMS.txt'), 'utf8');
  const rows = raw.trimEnd().split(/\r?\n/u);
  const seen = new Set();
  const parsed = [];
  for (const row of rows) {
    const match = row.match(/^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._+-]*)$/u);
    if (!match || match[2].includes('..') || seen.has(match[2])) fail('SHA256SUMS.txt contains an invalid or duplicate entry.');
    seen.add(match[2]);
    const file = path.join(dir, match[2]);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await sha256File(file) !== match[1]) fail(`Checksum verification failed for ${match[2]}.`);
    parsed.push({ name: match[2], sha256: match[1], size: stat.size, file });
  }
  return parsed;
}

async function verifyEmbedded(metadata) {
  const resourceDir = path.join(outputDirectory(), platform === 'win32' ? 'win-unpacked/resources' : 'linux-unpacked/resources');
  const appAsar = path.join(resourceDir, 'app.asar');
  const requireFromApp = createRequire(path.join(source, 'package.json'));
  const asar = requireFromApp('@electron/asar');
  const packaged = JSON.parse(asar.extractFile(appAsar, 'package.json').toString('utf8'));
  if (packaged.version !== metadata.version || (packaged.onecodeBuildChannel ?? 'stable') !== metadata.channel) fail('Packaged app.asar version or build channel is wrong.');
  const extension = JSON.parse(await fs.readFile(path.join(resourceDir, 'extension/manifest.json'), 'utf8'));
  if (extension.version !== metadata.version || extension.version_name !== (metadata.channel === 'beta' ? `${metadata.version} Beta` : metadata.version)) {
    fail('Packaged Companion version or channel is wrong.');
  }
  const runtime = JSON.parse(await fs.readFile(path.join(resourceDir, 'updater/runtime.json'), 'utf8'));
  if (runtime.platform !== platform || runtime.arch !== arch || runtime.baseVersion !== metadata.version || !/^[a-f0-9]{64}$/u.test(runtime.id)) {
    fail('Packaged runtime descriptor does not match the selected build.');
  }
  if ((runtime.channel ?? 'stable') !== metadata.channel) fail('Packaged runtime channel is wrong.');
  return { resourceDir, runtime };
}

async function verifyPrepared(metadata) {
  const dir = outputDirectory();
  const { runtime } = await verifyEmbedded(metadata);
  const expected = expectedNames(metadata).sort();
  const rows = await checksumRows(dir);
  const actual = rows.map(row => row.name).sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    fail(`Prepared checksum inventory is not the curated ${platform} ${selectedOperation} asset set.`);
  }
  const baseName = platform === 'win32'
    ? `${metadata.channel === 'beta' ? 'OneCode-Beta' : 'OneCode'}-Base-x64.json`
    : `${metadata.channel === 'beta' ? 'OneCode-Beta' : 'OneCode'}-Linux-Base-x64.json`;
  let baseReceipt;
  const capsule = selectedOperation === 'beta-capsule' || selectedOperation === 'stable-capsule';
  if (!capsule) {
    const base = JSON.parse(await fs.readFile(path.join(dir, baseName), 'utf8'));
    if (base.version !== metadata.version || base.runtime !== runtime.id || base.platform !== platform || base.arch !== arch) {
      fail('Full base descriptor does not match the packaged runtime and target.');
    }
    if (metadata.channel === 'beta' && (base.channel !== 'beta' || base.tag !== metadata.tag)) fail('Beta base descriptor channel or tag mismatch.');
    const descriptorRow = rows.find(row => row.name === baseName);
    if (!descriptorRow) fail('The full base descriptor is absent from the checksum inventory.');
    baseReceipt = { version: base.version, tag: base.tag || metadata.tag, runtime: base.runtime, installer: base.installer,
      installerSha256: base.sha256, descriptor: baseName, descriptorSha256: descriptorRow.sha256 };
  }
  const hotfixName = platform === 'win32'
    ? `${metadata.channel === 'beta' ? 'OneCode-Beta' : 'OneCode'}-Hotfix-x64.json`
    : `${metadata.channel === 'beta' ? 'OneCode-Beta' : 'OneCode'}-Linux-Hotfix-x64.json`;
  if (capsule || selectedOperation === 'stable-full' || selectedOperation === 'stable-release') {
    const hotfix = JSON.parse(await fs.readFile(path.join(dir, hotfixName), 'utf8'));
    if (hotfix.version !== metadata.version || hotfix.platform !== platform || hotfix.arch !== arch || hotfix.runtime !== runtime.id) {
      fail('Hotfix manifest does not match the packaged runtime and target.');
    }
    const base = hotfix.base;
    if (!base || base.runtime !== runtime.id || base.platform !== platform || base.arch !== arch) fail('Hotfix base binding does not match its runtime.');
    if (selectedOperation === 'beta-capsule' && (hotfix.channel !== 'beta' || base.version !== baseVersion || base.channel !== 'beta' || base.tag !== `beta-v${baseVersion}`)) {
      fail('Beta capsule is not bound to the requested published Beta base.');
    }
    if (selectedOperation === 'stable-capsule' && (hotfix.channel && hotfix.channel !== 'stable' || base.version !== baseVersion || base.channel && base.channel !== 'stable' || base.tag && base.tag !== `v${baseVersion}`)) {
      fail('Stable capsule is not bound to the requested published stable base.');
    }
    if (selectedOperation === 'stable-release' && (hotfix.channel && hotfix.channel !== 'stable' || base.version !== baseVersion || base.channel && base.channel !== 'stable' || base.tag && base.tag !== `v${baseVersion}`)) {
      fail('Stable release compatibility capsule is not bound to the requested published stable base.');
    }
    if (selectedOperation === 'stable-full' && (hotfix.channel && hotfix.channel !== 'stable' || base.version !== metadata.version)) {
      fail('Stable compatibility capsule is not bound to this full stable release.');
    }
    if (capsule) {
      baseReceipt = { version: base.version, tag: base.tag, runtime: base.runtime, installer: base.installer, installerSha256: base.sha256 };
    }
  }
  const sidecarName = `SHA256SUMS-${platform}-x64.txt`;
  const sidecar = rows.map(row => `${row.sha256}  ${row.name}`).join('\n') + '\n';
  const sidecarPath = path.join(dir, sidecarName);
  try {
    const previous = await fs.readFile(sidecarPath, 'utf8');
    if (previous !== sidecar) fail(`Existing ${sidecarName} differs from current checksums.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (process.argv.includes('--dry-run')) return { rows, runtime, baseReceipt, sidecarName, sidecarPath, sidecar, dir };
    await fs.writeFile(sidecarPath, sidecar, { flag: 'wx' });
  }
  return { rows, runtime, baseReceipt, sidecarName, sidecarPath, sidecar, dir };
}

async function writeBuildReceipt(metadata, staged) {
  const payloads = [
    ...staged.rows.map(({ name, size, sha256 }) => ({ name, bytes: size, sha256 })),
    { name: staged.sidecarName, bytes: Buffer.byteLength(staged.sidecar), sha256: createHash('sha256').update(staged.sidecar).digest('hex') }
  ];
  const receipt = {
    schema: 1,
    source: metadata.sha,
    tag: metadata.tag,
    version: metadata.version,
    channel: metadata.channel,
    platform,
    arch,
    operation: selectedOperation,
    runtime: staged.runtime.id,
    base: staged.baseReceipt,
    assets: payloads
  };
  const json = JSON.stringify(receipt, null, 2);
  if (env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(env.GITHUB_STEP_SUMMARY, `### OneCode ${metadata.channel} ${platform} x64 build receipt\n\n\`\`\`json\n${json}\n\`\`\`\n\n`);
  }
  console.log(json);
}

async function listAssets(release, token) {
  const assets = [];
  for (let page = 1; page <= 10; page++) {
    const next = await github(`/releases/${release.id}/assets?per_page=100&page=${page}`, token);
    assets.push(...next);
    if (next.length < 100) return assets;
  }
  fail('Draft has an unexpectedly large asset inventory.');
}

async function uploadFile(uploadUrl, token, asset) {
  const target = new URL(uploadUrl);
  target.searchParams.set('name', asset.name);
  const body = await new Promise((resolve, reject) => {
    const request = https.request(target, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(asset.size),
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'onecode-draft-app-build'
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`GitHub asset upload failed (${response.statusCode}) for ${asset.name}.`));
        try { resolve(JSON.parse(text)); } catch { reject(new Error(`GitHub returned invalid upload metadata for ${asset.name}.`)); }
      });
    });
    request.on('error', reject);
    createReadStream(asset.file).on('error', reject).pipe(request);
  });
  if (body.name !== asset.name || body.size !== asset.size || body.digest !== `sha256:${asset.sha256}`) {
    fail(`Uploaded asset metadata did not confirm the expected digest for ${asset.name}.`);
  }
  return body;
}

async function performUpload(token, metadata, staged) {
  let release = await verifyReleaseTarget(token, metadata);
  const assets = await listAssets(release, token);
  const uploadList = [...staged.rows, { name: staged.sidecarName, file: staged.sidecarPath, size: Buffer.byteLength(staged.sidecar), sha256: createHash('sha256').update(staged.sidecar).digest('hex') }];
  const existingByName = new Map(assets.map(asset => [asset.name, asset]));
  for (const asset of uploadList) {
    release = await verifyReleaseTarget(token, metadata);
    const previous = existingByName.get(asset.name);
    if (previous) {
      if (previous.size === asset.size && previous.digest === `sha256:${asset.sha256}`) {
        console.log(`Already present and verified: ${asset.name}`);
        continue;
      }
      fail(`Release already contains a different asset named ${asset.name}; refusing replacement.`);
    }
    await uploadFile(`https://uploads.github.com/repos/${OWNER}/${REPOSITORY}/releases/${release.id}/assets`, token, asset);
    console.log(`Uploaded ${asset.name} (${asset.size} bytes).`);
  }
  const finalAssets = await listAssets(release, token);
  const finalByName = new Map(finalAssets.map(asset => [asset.name, asset]));
  for (const asset of uploadList) {
    const remote = finalByName.get(asset.name);
    if (!remote || remote.size !== asset.size || remote.digest !== `sha256:${asset.sha256}`) fail(`Draft asset verification failed for ${asset.name}.`);
  }
  console.log(`Verified ${uploadList.length} curated assets on ${metadata.tag}.`);
}

validateInputs();
const metadata = sourceMetadata();
if (operation === 'verify') {
  if (!env.GH_TOKEN) fail('GH_TOKEN is required only for draft checks.');
  await verifyReleaseTarget(env.GH_TOKEN, metadata);
  console.log(`Verified exact source ${metadata.sha}, version ${metadata.version}, and release ${metadata.tag}.`);
} else if (operation === 'stage') {
  const staged = await verifyPrepared(metadata);
  await writeBuildReceipt(metadata, staged);
} else {
  if (!env.GH_TOKEN) fail('GH_TOKEN is required only for draft checks and uploads.');
  const staged = await verifyPrepared(metadata);
  await performUpload(env.GH_TOKEN, metadata, staged);
}
