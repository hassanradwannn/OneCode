'use strict';
// Runs from a private cache copy of Node, so replacing the install cannot kill it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => path.win32.normalize(a).replace(/[\\/]+$/, '').toLowerCase() === path.win32.normalize(b).replace(/[\\/]+$/, '').toLowerCase();
function validate(record) {
  if (![1, 2, 3].includes(record?.schema) || !/^\d+\.\d+\.\d+$/.test(record.version) ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(record.fileVersion) || !/^[a-f0-9]{64}$/.test(record.digest) ||
      !Number.isSafeInteger(record.pid) || record.pid < 1 || !Number.isSafeInteger(record.at) ||
      Date.now() - record.at < -60000 || Date.now() - record.at > 30 * 60000 ||
      !['installer', 'target', 'executable', 'log'].every(key => typeof record[key] === 'string' && path.win32.isAbsolute(record[key]) && !/[\r\n"\0]/.test(record[key])) ||
      !same(record.executable, path.win32.join(record.target, 'OneCode.exe')) ||
      !(record.schema !== 2 ? /^OneCode-Setup-(x64|arm64)\.exe$/.test(path.win32.basename(record.installer)) :
        /^OneCode-Hotfix-(x64|arm64)\.zip$/.test(path.win32.basename(record.installer)) &&
        typeof record.manifest === 'string' && same(record.manifest, path.win32.join(path.win32.dirname(record.installer), 'hotfix-manifest.json')) &&
        /^[a-f0-9]{64}$/.test(record.manifestDigest) && record.elevate === false)) {
    throw new Error('Invalid or expired update handoff');
  }
  if(record.schema===3 && (!/^\d+\.\d+\.\d+$/.test(record.baseVersion) || record.fileVersion!==`${record.baseVersion}.0` ||
    typeof record.patchArchive!=='string' || !path.win32.isAbsolute(record.patchArchive) || /[\r\n"\0]/.test(record.patchArchive) ||
    !/^OneCode-Hotfix-(x64|arm64)\.zip$/.test(path.win32.basename(record.patchArchive)) ||
    typeof record.manifest!=='string' || !same(record.manifest,path.win32.join(path.win32.dirname(record.patchArchive),'hotfix-manifest.json')) || !/^[a-f0-9]{64}$/.test(record.manifestDigest) || !/^[a-f0-9]{64}$/.test(record.patchDigest))) throw Error('Invalid composite update handoff');
  return record;
}
function noLinks(file) {
  for (let item = file; ; item = path.dirname(item)) {
    if (fs.lstatSync(item).isSymbolicLink()) throw new Error('Update paths must not redirect');
    if (path.dirname(item) === item) break;
  }
}
const ps = script => cp.execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
  ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" + script, 'utf16le').toString('base64')],
  { windowsHide: true, timeout: 20000, encoding: 'utf8', maxBuffer: 65536 }).trim();
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function tail(file, limit = 65536) {
  if (!fs.existsSync(file)) return '';
  const handle = fs.openSync(file, 'r');
  try { const size = fs.fstatSync(handle).size, bytes = Buffer.alloc(Math.min(limit, size)); fs.readSync(handle, bytes, 0, bytes.length, Math.max(0, size - bytes.length)); return bytes.toString('utf8'); }
  finally { fs.closeSync(handle); }
}
function readyWindow(text, since, version) {
  const lines = text.split(/\r?\n/).filter(line => Date.parse(line.slice(0, 24)) >= since);
  const loaded = lines.some(line => line.includes('window loaded'));
  let visible = false;
  for (const line of lines) {
    const marker = 'main window presentation ';
    const index = line.indexOf(marker);
    if (index < 0) continue;
    try {
      const state = JSON.parse(line.slice(index + marker.length));
      visible = state.visible === true && state.minimized === false && state.quitting === false;
    } catch { /* Incomplete diagnostic lines cannot prove presentation. */ }
  }
  return loaded && visible && (!version || lines.some(line => line.endsWith(`app version ${version}`)));
}
function registration(target) {
  const guid = '7b3f238f-62c9-5e7a-a1d5-02806675d41d';
  const rows = JSON.parse(ps(`$rows=@(foreach($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)){$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view);try{$a=$base.OpenSubKey('Software\\${guid}');$b=$base.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}');if($a -or $b){@{location=$(if($a){$a.GetValue('InstallLocation')});uninstall=$(if($b){$b.GetValue('UninstallString')})}}}finally{if($a){$a.Dispose()};if($b){$b.Dispose()};$base.Dispose()}});ConvertTo-Json -InputObject $rows -Compress`));
  if (!rows.length || rows.some(row => !row.location || !same(row.location, target) || row.uninstall !== `"${path.win32.join(target, 'Uninstall OneCode.exe')}" /currentuser`)) throw new Error('Installation registration changed');
}
function processes(executable) {
  return JSON.parse(ps(`ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter "Name='OneCode.exe'" | Where-Object {$_.ExecutablePath -eq ${quote(executable)}} | Select-Object ProcessId,ParentProcessId) -Compress`));
}
function ownedShortcutIcon(value, executable) {
  const match = /^(.*),\s*0$/.exec(String(value).trim());
  if (!match) return false;
  const icon = match[1].trim().replace(/^"(.*)"$/, '$1');
  // An empty icon path means the link target's own icon, not a foreign resource.
  return !icon || same(icon, executable) || same(icon, path.win32.join(path.win32.dirname(executable), 'resources', 'runtime-icon.ico'));
}
function shortcuts(executable) {
  const rows = JSON.parse(ps(`$shell=New-Object -ComObject WScript.Shell;$menu=Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\OneCode.lnk';$desktop=Join-Path ([Environment]::GetFolderPath('Desktop')) 'OneCode.lnk';if(-not(Test-Path -LiteralPath $menu)){throw 'OneCode Start-menu shortcut is missing'};$rows=@(foreach($file in @($menu,$desktop)){if(Test-Path -LiteralPath $file){$link=$shell.CreateShortcut($file);@{target=$link.TargetPath;icon=$link.IconLocation}}});ConvertTo-Json -InputObject $rows -Compress`));
  for (const row of rows) {
    if (!same(row.target, executable)) throw new Error('OneCode shortcut points outside the installed app');
    if (!ownedShortcutIcon(row.icon, executable)) throw new Error('OneCode shortcut icon points outside the installed app');
  }
}

function execute(file, args, elevate) {
  if (elevate) {
    // Only an explicit handoff can reach this permission prompt.
    const command = `$p=Start-Process -FilePath ${quote(file)} -ArgumentList ${quote(args.join(' '))} -Verb RunAs -PassThru -WindowStyle Hidden; $p.WaitForExit(); exit $p.ExitCode`;
    return execute(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], false);
  }
  return new Promise((resolve, reject) => {
    const child = cp.spawn(file, args, { windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' });
    const timer = setTimeout(() => reject(new Error(`Installer completion timed out (pid ${child.pid}); no retry attempted`)), 10 * 60000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Installer exited ${code}`)); });
  });
}
async function run(note, dependencies = {}) {
  const record = validate(JSON.parse(fs.readFileSync(note, 'utf8')));
  noLinks(note); noLinks(record.installer); noLinks(record.executable);
  const logFile = path.join(path.dirname(note), 'bootstrap.log');
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 65536) fs.writeFileSync(logFile, tail(logFile, 32768));
  const log = message => fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
  const persist = status => { record.status = status; fs.writeFileSync(note + '.tmp', JSON.stringify(record)); fs.renameSync(note + '.tmp', note); };
  try {
    log(`handoff ${record.version}; waiting for original pid ${record.pid}`);
    // Wait for the old executable's complete tree; never terminate user work.
    const listing = dependencies.processes || processes;
    const deadline = Date.now() + 90000;
    while (listing(record.executable).length) {
      if (Date.now() > deadline) throw new Error('Original OneCode process tree did not exit');
      await sleep(500);
    }
    log('original process tree exited');
    const registered = dependencies.registration || registration;
    registered(record.target);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(record.installer)).digest('hex');
    if (digest !== record.digest) throw new Error('Staged installer digest changed');
    if (record.schema === 2) {
      await runHotfix(record, note, dependencies, listing, log, persist);
      return;
    }
    let patch;
    if(record.schema===3) {
      patch={...record,schema:2,installer:record.patchArchive,digest:record.patchDigest,elevate:false};
      const {manifest}=await verifiedPayload(patch);
      if(!manifest.base || manifest.base.version!==record.baseVersion || manifest.base.sha256!==record.digest || manifest.base.installer!==path.basename(record.installer) || manifest.base.size!==fs.statSync(record.installer).size) throw Error('Composite installer differs from the hotfix base');
    }
    persist('installing');
    // NSIS /D is final and unquoted. The bootstrap owns restart; no --force-run.
    await (dependencies.execute || execute)(record.installer, ['/S', '--updated', '--onecode-bootstrap', '/currentuser', `/D=${record.target}`], record.elevate === true);
    log('installer exited 0');
    noLinks(record.executable); registered(record.target);
    const installed = dependencies.version ? dependencies.version() : ps(`(Get-Item -LiteralPath ${quote(record.executable)}).VersionInfo.ProductVersion`);
    const normalizedVersion = value => /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value) ? value.split('.').concat('0').slice(0, 4).join('.') : null;
    if (normalizedVersion(installed) !== normalizedVersion(record.fileVersion)) throw new Error(`Installed version ${installed} differs from ${record.fileVersion}`);
    log(`installed version ${installed}; sha256 ${crypto.createHash('sha256').update(fs.readFileSync(record.executable)).digest('hex')}`);
    (dependencies.shortcuts || shortcuts)(record.executable);
    log('installed shortcuts verified');
    if(patch) {
      if(listing(record.executable).length) throw Error('Base installer unexpectedly started OneCode before the hotfix');
      log('base installed without relaunch; applying verified hotfix');
      await runHotfix(patch,note,dependencies,listing,log,persist);return;
    }
    persist('relaunching');
    if (!listing(record.executable).length) {
      // An explicit Update and restart must show the GUI successor. Only the
      // helper/installer are hidden; do not pass SW_HIDE to the app itself.
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const child = (dependencies.launch || cp.spawn)(record.executable, ['--updated'], { detached: true, stdio: 'ignore', windowsHide: false, env });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      log(`launched installed executable pid ${child.pid}`);
    } else log('installer already launched exact installed executable');
    const startupDeadline = Date.now() + 45000;
    let stableSince = 0;
    while (true) {
      const running = listing(record.executable).length > 0;
      if (running && !stableSince) stableSince = Date.now();
      if (!running) stableSince = 0;
      if (running && Date.now() - stableSince >= 5000 && readyWindow(tail(record.log), record.at)) break;
      if (Date.now() > startupDeadline) throw new Error('Installed app did not reach a stable visible window');
      await sleep(1000);
    }
    log('success: installed app survived and window loaded and visible');
    persist('success');
    fs.renameSync(note, path.join(path.dirname(note), 'last-success.json'));
  } catch (error) {
    record.error = String(error.message).slice(0, 500); persist('failed'); log(`failed: ${record.error}`);
    throw error;
  }
}
async function verifiedPayload(record) {
  const contract = require('./hotfix-contract.cjs');
  contract.noLinks(record.installer);
  contract.noLinks(record.manifest);
  if (await contract.hash(record.manifest) !== record.manifestDigest) throw Error('Hotfix manifest changed after verification');
  const manifest = contract.manifest(JSON.parse(fs.readFileSync(record.manifest, 'utf8')));
  if (manifest.version !== record.version || manifest.archive !== path.basename(record.installer) || manifest.sha256 !== record.digest || fs.statSync(record.installer).size !== manifest.size) throw Error('Hotfix handoff differs from manifest');
  if(await contract.hash(record.installer)!==record.digest) throw Error('Hotfix archive changed after verification');
  const payload = path.join(path.dirname(record.installer), 'hotfix-payload');
  await contract.verify(payload, manifest.files);
  return {manifest,payload};
}
async function runHotfix(record, note, dependencies, listing, log, persist) {
  const contract = require('./hotfix-contract.cjs');
  const resources = path.join(record.target, 'resources');
  const {manifest,payload}=await verifiedPayload(record);
  const runtime = contract.runtime(JSON.parse(fs.readFileSync(path.join(resources, 'updater/runtime.json'), 'utf8')));
  if (runtime.id !== manifest.runtime || runtime.arch !== manifest.arch) throw Error('Hotfix native runtime differs');
  await contract.verify(resources, runtime.files);
  const previous = await contract.inventory(resources, contract.mutable);
  const backup = path.join(path.dirname(note), `rollback-${record.version}-${record.at}`);
  contract.noLinks(backup);
  if (fs.existsSync(backup)) throw Error('Hotfix rollback directory already exists; no replay attempted');
  for (const entry of previous) {
    const file = contract.location(backup, entry.path); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(contract.location(resources, entry.path), file);
  }
  await contract.verify(backup, previous);
  const names = new Set(manifest.files.map(file => file.path));
  const changed = new Set(), temporaryFiles = new Set();
  persist('installing');
  try {
    // The canonical shutdown has finished. Refuse a manually started successor.
    if (listing(record.executable).length) throw Error('OneCode restarted before hotfix replacement');
    for (const entry of manifest.files) {
      const destination = contract.location(resources, entry.path), temporary = destination + '.onecode-next';
      contract.noLinks(temporary);
      temporaryFiles.add(temporary);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(contract.location(payload, entry.path), temporary);
      if (await contract.hash(temporary) !== entry.sha256) throw Error('Hotfix replacement checksum differs');
      fs.renameSync(temporary, destination); changed.add(entry.path);
    }
    for (const entry of previous) if (!names.has(entry.path)) { fs.unlinkSync(contract.location(resources, entry.path)); changed.add(entry.path); }
    await contract.verify(resources, manifest.files);
    (dependencies.registration || registration)(record.target);
    (dependencies.shortcuts || shortcuts)(record.executable);
    persist('relaunching');
    await launchSuccessor(record, dependencies, listing, log, record.version);
    log('success: application hotfix loaded; native runtime retained');
    persist('success'); fs.renameSync(note, path.join(path.dirname(note), 'last-success.json'));
  } catch (error) {
    // Never overwrite files or terminate a successor that may already be doing user work.
    if (listing(record.executable).length) { log('successor still running; rollback retained for recovery after close'); throw error; }
    for (const name of changed) {
      const old = previous.find(file => file.path === name), destination = contract.location(resources, name);
      if (old) fs.copyFileSync(contract.location(backup, name), destination);
      else if (fs.existsSync(destination)) fs.unlinkSync(destination);
    }
    for (const temporary of temporaryFiles) { contract.noLinks(temporary); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    await contract.verify(resources, previous);
    log('application hotfix rolled back; previous application files restored');
    try { await launchSuccessor(record, dependencies, listing, log); } catch { log('previous app relaunch could not be confirmed; backup retained'); }
    throw error;
  }
}
async function launchSuccessor(record, dependencies, listing, log, version) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = (dependencies.launch || cp.spawn)(record.executable, ['--updated'], { detached: true, stdio: 'ignore', windowsHide: false, env });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
  const deadline = Date.now() + 45000; let stable = 0;
  while (true) {
    const running = listing(record.executable).length > 0;
    if (running && !stable) stable = Date.now(); if (!running) stable = 0;
    if (running && Date.now() - stable >= 5000 && readyWindow(tail(record.log), record.at, version)) return;
    if (Date.now() > deadline) throw Error('Hotfix successor did not reach a stable visible window and expected version');
    await sleep(1000);
  }
}
module.exports = { validate, run, readyWindow, ownedShortcutIcon, runHotfix };
if (require.main === module) run(process.argv[2]).catch(() => { process.exitCode = 1; });
