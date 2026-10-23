// Copied with its bundled Node runtime outside the AppImage mount before the old app exits.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = process.getBuiltinModule('node:child_process');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const absolute = value => typeof value === 'string' && path.posix.isAbsolute(value) && !/[\0\r\n]/.test(value);
function validate(record) {
  if (record?.schema !== 1 || !['stable', 'beta'].includes(record.channel) ||
      !/^\d+\.\d+\.\d+$/.test(record.version) || !/^[a-f0-9]{64}$/.test(record.nonce) ||
      !/^[a-f0-9]{64}$/.test(record.digest) || !['appimage', 'deb'].includes(record.installation) ||
      !Number.isSafeInteger(record.pid) || record.pid < 1 || !/^\d+$/.test(record.startTicks) ||
      !Number.isSafeInteger(record.at) || !absolute(record.executable) || !absolute(record.userData) ||
      !['pending', 'waiting-exit', 'launching', 'ready', 'failed'].includes(record.status) ||
      record.error !== undefined && (typeof record.error !== 'string' || record.error.length > 500) ||
      record.browserUserData !== undefined && !absolute(record.browserUserData) ||
      record.bridgePorts !== undefined && (typeof record.bridgePorts !== 'string' || !/^\d+(?:,\d+)*$/.test(record.bridgePorts) ||
        record.bridgePorts.split(',').length > 32 || record.bridgePorts.split(',').some(port => Number(port) > 65535)))
    throw Error('Invalid Linux update handoff');
  return record;
}
function processIdentity(pid, read = fs.readFileSync) {
  try {
    const stat = read(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return fields[0] === 'Z' ? null : fields[19] ?? null;
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}
function successorArguments(record) {
  return [`--user-data-dir=${record.userData}`, `--onecode-linux-update=${record.nonce}`,
    ...(record.browserUserData ? [`--onecode-browser-user-data=${record.browserUserData}`] : []),
    ...(record.bridgePorts ? [`--onecode-bridge-ports=${record.bridgePorts}`] : [])];
}
function successorEnvironment(record, source = process.env) {
  const env = { ...source }, mount = env.APPDIR;
  for (const key of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'APPIMAGE_EXIT_AFTER_INSTALL', 'APPIMAGE_SILENT_INSTALL', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  if (mount && absolute(mount)) {
    for (const key of ['PATH', 'LD_LIBRARY_PATH', 'LD_PRELOAD', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']) {
      if (!env[key]) continue;
      env[key] = env[key].split(':').filter(entry => entry !== mount && !entry.startsWith(mount + '/')).join(':');
      if (!env[key]) delete env[key];
    }
  }
  env.ONECODE_USER_DATA = record.userData;
  if (record.browserUserData) env.ONECODE_BROWSER_USER_DATA = record.browserUserData;
  if (record.bridgePorts) env.CLF_BRIDGE_PORTS = record.bridgePorts;
  return env;
}
function atomic(file, value) {
  const temporary = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}
function unlinked(file) {
  const stat = fs.lstatSync(file);
  for (let node = file; ; node = path.dirname(node)) {
    if (fs.lstatSync(node).isSymbolicLink()) throw Error('Redirected Linux update handoff path');
    const parent = path.dirname(node); if (parent === node) return stat;
  }
}
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
/** Public 0.5.1 predates the nonce callback. Limit compatibility to that exact legacy release. */
function legacyWindowReady(record, launchedAt, childPid, childIdentity, identify = processIdentity) {
  if (record.version !== '0.5.1' || record.installation !== 'appimage' || !Number.isSafeInteger(childPid) ||
      !childIdentity || identify(childPid) !== childIdentity) return false;
  const file = path.join(record.userData, 'app.log');
  try {
    // The existing logger rotates at 4 MiB; refuse an unrelated oversized file.
    if (unlinked(file).size > 5 * 1024 * 1024) return false;
    const lines = fs.readFileSync(file, 'utf8').slice(-128 * 1024).split(/\r?\n/)
      .filter(line => Date.parse(line.slice(0, 24)) >= launchedAt);
    const version = lines.some(line => /\sinfo\s+app version 0\.5\.1$/.test(line));
    const loaded = lines.some(line => /\sinfo\s+window loaded$/.test(line));
    const shown = lines.some(line => {
      const marker = 'main window presentation ', at = line.indexOf(marker);
      if (at < 0) return false;
      try {
        const event = JSON.parse(line.slice(at + marker.length));
        return event.event === 'show' && event.visible === true && event.minimized === false && event.quitting === false;
      } catch { return false; }
    });
    return version && loaded && shown;
  } catch { return false; }
}
/** Only this observer's own private, nonce-scoped copy may unlink its running ELF on Linux. */
function cleanupOwnRuntime(record) {
  const directory = path.join(record.userData, 'updates', `linux-${record.nonce}`);
  const runtime = path.join(directory, 'node'), helper = path.join(directory, 'linux-update-helper.cjs');
  try {
    if (process.execPath !== runtime || __filename !== helper || fs.realpathSync(runtime) !== runtime ||
        fs.realpathSync(helper) !== helper) return false;
    const running = fs.statSync('/proc/self/exe'), copied = unlinked(runtime);
    if (!copied.isFile() || copied.dev !== running.dev || copied.ino !== running.ino || !unlinked(helper).isFile()) return false;
    fs.unlinkSync(helper); fs.unlinkSync(runtime);
    try { fs.rmdirSync(directory); } catch { /* Preserve any unexpected entries; never recurse. */ }
    return true;
  } catch { return false; }
}
async function run(note, dependencies = {}) {
  unlinked(note);
  const record = validate(JSON.parse(fs.readFileSync(note, 'utf8')));
  if (note !== path.join(record.userData, 'updates', 'linux-handoff.json') || record.status !== 'pending' ||
      Date.now() - record.at < -60000 || Date.now() - record.at > 5 * 60000) throw Error('Linux update handoff is not pending');
  const log = message => {
    try { fs.appendFileSync(path.join(record.userData, 'app.log'), `${new Date().toISOString()} info update: Linux handoff ${message.slice(0, 500)}\n`); } catch {}
  };
  const persist = (status, error, proof) => {
    if (JSON.parse(fs.readFileSync(note, 'utf8')).nonce !== record.nonce) throw Error('The Linux update receipt was superseded');
    atomic(note, { ...record, status, ...(error ? { error } : {}), ...(proof ? { proof } : {}) });
  };
  const identify = dependencies.identity || processIdentity, wait = dependencies.sleep || sleep, now = dependencies.now || Date.now;
  try {
    persist('waiting-exit');
    const exitDeadline = now() + 60000;
    while (identify(record.pid) === record.startTicks) {
      if (now() >= exitDeadline) throw Error('The previous app did not finish shutdown; no successor was launched');
      await wait(200);
    }
    const current = JSON.parse(fs.readFileSync(note, 'utf8'));
    if (current.nonce !== record.nonce || current.status !== 'waiting-exit') throw Error('The Linux successor handoff was superseded; no successor was launched');
    if (!unlinked(record.executable).isFile() || await digest(record.executable) !== record.digest)
      throw Error('The installed Linux successor changed after verification');
    persist('launching');
    log(`${record.version} predecessor exited; launching the verified successor once`);
    const launchedAt = Date.now();
    const child = (dependencies.launch || cp.spawn)(record.executable, successorArguments(record), {
      detached: true, stdio: 'ignore', cwd: path.dirname(record.executable), env: successorEnvironment(record)
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    const childIdentity = Number.isSafeInteger(child.pid) ? identify(child.pid) : null;
    const deadline = now() + 60000, readyFile = path.join(record.userData, 'updates', 'linux-ready.json');
    let stable = null;
    while (true) {
      let ready;
      try { unlinked(readyFile); ready = JSON.parse(fs.readFileSync(readyFile, 'utf8')); } catch {}
      const native = ready?.nonce === record.nonce && ready.version === record.version && ready.channel === record.channel &&
          ready.executable === record.executable && ready.userData === record.userData && ready.visible === true &&
          ready.minimized === false && Number.isSafeInteger(child.pid) && ready.pid === child.pid && ready.pid !== record.pid &&
          ready.startTicks === childIdentity && typeof ready.startTicks === 'string' && identify(ready.pid) === ready.startTicks;
      const legacy = legacyWindowReady(record, launchedAt, child.pid, childIdentity, identify);
      if (native || legacy) {
        if (stable === null) stable = now();
        if (now() - stable >= 3000) {
          persist('ready', undefined, native ? 'native-window-receipt' : 'legacy-profile-window-log');
          log(`${record.version} reached its visible ready window (${native ? 'native receipt' : 'legacy exact-profile log and owned process'})`); return;
        }
      } else stable = null;
      if (now() >= deadline) throw Error('The Linux successor did not confirm its expected version and visible ready window; no retry was launched');
      await wait(250);
    }
  } catch (error) {
    // No retries, process termination, rollback overwrite, or mutation replay from this observer.
    const reason = error?.code && /^[a-z0-9_-]{1,64}$/i.test(String(error.code)) ? `Successor handoff failed (${error.code})` :
      /^(The previous app|The installed Linux|The Linux successor)/.test(error?.message) ? error.message : 'The Linux successor could not be launched';
    persist('failed', reason); log(`${record.version} failed: ${reason}`); throw error;
  } finally { cleanupOwnRuntime(record); }
}
module.exports = { validate, processIdentity, successorArguments, successorEnvironment, legacyWindowReady, cleanupOwnRuntime, run };
if (require.main === module) run(process.argv[2]).catch(() => { process.exitCode = 1; });
