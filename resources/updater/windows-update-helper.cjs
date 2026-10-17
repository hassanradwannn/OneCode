'use strict';
// Runs from a private cache copy of Node, so replacing the install cannot kill it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => path.win32.normalize(a).replace(/[\\/]+$/, '').toLowerCase() === path.win32.normalize(b).replace(/[\\/]+$/, '').toLowerCase();
function validate(record) {
  if (record?.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(record.version) ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(record.fileVersion) || !/^[a-f0-9]{64}$/.test(record.digest) ||
      !Number.isSafeInteger(record.pid) || record.pid < 1 || !Number.isSafeInteger(record.at) ||
      Date.now() - record.at < -60000 || Date.now() - record.at > 30 * 60000 ||
      !['installer', 'target', 'executable', 'log'].every(key => typeof record[key] === 'string' && path.win32.isAbsolute(record[key]) && !/[\r\n"\0]/.test(record[key])) ||
      !same(record.executable, path.win32.join(record.target, 'OneCode.exe')) ||
      path.win32.basename(record.installer) !== 'OneCode-Setup-x64.exe' && path.win32.basename(record.installer) !== 'OneCode-Setup-arm64.exe') {
    throw new Error('Invalid or expired update handoff');
  }
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
function registration(target) {
  const guid = '7b3f238f-62c9-5e7a-a1d5-02806675d41d';
  const rows = JSON.parse(ps(`$rows=@(foreach($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)){$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view);try{$a=$base.OpenSubKey('Software\\${guid}');$b=$base.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}');if($a -or $b){@{location=$(if($a){$a.GetValue('InstallLocation')});uninstall=$(if($b){$b.GetValue('UninstallString')})}}}finally{if($a){$a.Dispose()};if($b){$b.Dispose()};$base.Dispose()}});ConvertTo-Json -InputObject $rows -Compress`));
  if (!rows.length || rows.some(row => !row.location || !same(row.location, target) || row.uninstall !== `"${path.win32.join(target, 'Uninstall OneCode.exe')}" /currentuser`)) throw new Error('Installation registration changed');
}
function processes(executable) {
  return JSON.parse(ps(`ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter "Name='OneCode.exe'" | Where-Object {$_.ExecutablePath -eq ${quote(executable)}} | Select-Object ProcessId,ParentProcessId) -Compress`));
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
    persist('installing');
    // NSIS /D is final and unquoted. The bootstrap owns restart; no --force-run.
    await (dependencies.execute || execute)(record.installer, ['/S', '--updated', '/currentuser', `/D=${record.target}`], record.elevate === true);
    log('installer exited 0');
    noLinks(record.executable); registered(record.target);
    const installed = dependencies.version ? dependencies.version() : ps(`(Get-Item -LiteralPath ${quote(record.executable)}).VersionInfo.ProductVersion`);
    if (installed !== record.fileVersion) throw new Error(`Installed version ${installed} differs from ${record.fileVersion}`);
    log(`installed version ${installed}; sha256 ${crypto.createHash('sha256').update(fs.readFileSync(record.executable)).digest('hex')}`);
    persist('relaunching');
    if (!listing(record.executable).length) {
      const child = (dependencies.launch || cp.spawn)(record.executable, ['--updated'], { detached: true, stdio: 'ignore', windowsHide: true });
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
      const loaded = tail(record.log).split(/\r?\n/).some(line => Date.parse(line.slice(0, 24)) >= record.at && line.includes('window loaded'));
      if (running && Date.now() - stableSince >= 5000 && loaded) break;
      if (Date.now() > startupDeadline) throw new Error('Installed app did not reach stable window initialization');
      await sleep(1000);
    }
    log('success: installed app survived and window loaded');
    persist('success');
    fs.renameSync(note, path.join(path.dirname(note), 'last-success.json'));
  } catch (error) {
    record.error = String(error.message).slice(0, 500); persist('failed'); log(`failed: ${record.error}`);
    throw error;
  }
}
module.exports = { validate, run };
if (require.main === module) run(process.argv[2]).catch(() => { process.exitCode = 1; });
