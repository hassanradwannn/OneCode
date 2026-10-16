/** Release input isolation: inspect assembled bytes, never a user's installed profile. */
import { listPackage, extractFile, statFile } from '@electron/asar';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';

const normalize = value => value.replace(/\\/g, '/').replace(/^\/+/, '');
const privatePath = /(?:^|\/)(?:\.env(?:\.[^/]*)?|secrets\.bin|[^/]*\.private\.(?:json|txt))$/i;
const browserCredentialFile = /(?:^|\/)(?:Cookies(?:-journal)?|Login Data(?:-journal)?|Web Data(?:-journal)?|Local State)$/i;
// Vendor modules legitimately contain source directories named cookies. Browser databases
// are files; never exempt an entire vendor subtree from the private-file audit.
const isPrivate = (label, isDirectory) => privatePath.test(label) || !isDirectory && browserCredentialFile.test(label);
const developerPath = /(?:[A-Z]:(?:\\+|\/+)(?:Gemini Code|OneCode|chat-on-steroids)(?:\\+|\/+)|[A-Z]:(?:\\+|\/+)Users(?:\\+|\/+)(?!(?:you|example|Public|Default)(?:\\+|\/+))[^\\/\r\n"'<>]+(?:\\+|\/+))/i;
function inspectText(bytes, label) {
  if (developerPath.test(bytes.toString('utf8'))) throw new Error(`Developer-specific path in packaged ${label}`);
}
export function assertWindowsPackageIsolation(resources) {
  const archive = path.join(resources, 'app.asar');
  const manifest = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  if (manifest.name !== 'onecode' || manifest.desktopName !== 'io.onecode.desktop') throw new Error('Unexpected packaged app identity');
  let ownedFiles = 0;
  for (const raw of listPackage(archive)) {
    const file = normalize(raw);
    if (!['node_modules', 'out', 'package.json'].includes(file.split('/')[0])) throw new Error(`Unapproved top-level app input: ${file}`);
    const isDirectory = 'files' in statFile(archive, file.split('/').join(path.sep), false);
    if (isPrivate(file, isDirectory) || file.startsWith('out/') && /(?:\.map$|(?:^|\/)(?:test|fixtures|runtime|scratch|app-setup)(?:\/|$))/i.test(file))
      throw new Error(`Private/development file in packaged app: ${file}`);
    if (file.startsWith('out/') && /\.(?:js|json|css|html|md|txt)$/i.test(file)) {
      inspectText(extractFile(archive, file.split('/').join(path.sep)), file); ownedFiles++;
    }
  }
  const allowed = new Set(['app.asar', 'app.asar.unpacked', 'app-update.yml', 'extension', 'node', 'pets', 'rg', 'tunnel', 'skills',
    'LICENSE', 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'THIRD-PARTY-NOTICES.txt', 'WINDOWS-SETUP.md']);
  for (const name of readdirSync(resources)) if (!allowed.has(name) && !/^THIRD-PARTY-NOTICES-sharp-win32-(?:x64|arm64)\.md$/.test(name))
    throw new Error(`Unapproved resource input: ${name}`);
  if (readdirSync(resources).includes('app-update.yml')) {
    const feed = loadYaml(readFileSync(path.join(resources, 'app-update.yml'), 'utf8'));
    const expected = { owner: 'hassanradwannn', repo: 'OneCode', provider: 'github', updaterCacheDirName: 'onecode-updater' };
    if (!feed || typeof feed !== 'object' || Object.keys(feed).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, value]) => feed[key] !== value))
      throw new Error('Unapproved packaged updater feed');
  }
  function visit(directory, relative = '') {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name), label = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error(`Linked/special file in packaged resources: ${label}`);
      if ((label === 'skills' || label.startsWith('skills/')) && !(stat.isDirectory()
        ? label === 'skills' || label === 'skills/gemini-code'
        : label === 'skills/gemini-code/SKILL.md')) throw new Error(`Unapproved skill resource input: ${label}`);
      if (isPrivate(label, stat.isDirectory())) throw new Error(`Private profile/credential file in packaged resources: ${label}`);
      if (stat.isDirectory()) visit(file, label);
      else if ((label.startsWith('extension/') || label === 'WINDOWS-SETUP.md' || label === 'skills/gemini-code/SKILL.md') && /\.(?:js|json|html|css|md|txt)$/i.test(label)) {
        inspectText(readFileSync(file), label); ownedFiles++;
      }
    }
  }
  visit(resources);
  return { ownedFiles, identity: manifest.name };
}
