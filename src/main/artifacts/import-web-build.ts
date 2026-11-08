import path from 'node:path';
import { init, parse as parseModule } from 'es-module-lexer';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import type { Root } from '../../shared/types.js';
import { effectiveCapabilities, getConfig } from '../config.js';
import { rawPromises as fs } from '../rawfs.js';
import { resolvePath, type Resolved } from '../sandbox.js';
import { createArtifact, type CreateArtifactInput } from './service.js';

const MAX_FILES = 128, MAX_FILE = 2 * 1024 * 1024, MAX_BUNDLE = 8 * 1024 * 1024;

async function readBuildFile(roots: readonly Root[], file: Resolved, remaining: number): Promise<Buffer> {
  const handle = await fs.open(file.real, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > Math.min(MAX_FILE, remaining))
      throw new Error('ARTIFACT_BUILD_INVALID: A file exceeds the artifact size limit.');
    const data = Buffer.alloc(before.size);
    for (let offset = 0; offset < data.length;) {
      const read = await handle.read(data, offset, data.length - offset, offset);
      if (!read.bytesRead) throw new Error('Build file changed during import');
      offset += read.bytesRead;
    }
    const checked = await resolvePath(roots, file.virtual);
    const after = await fs.stat(checked.real);
    if (checked.real !== file.real || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error('Build file changed during import');
    return data;
  } finally { await handle.close(); }
}

function decodeBuildFile(file: string, data: Buffer): CreateArtifactInput['files'][number] {
  try {
    return { path: file, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) };
  } catch {
    throw new Error('ARTIFACT_BUILD_UNSUPPORTED: Offline web files must use UTF-8 text. Save the file as UTF-8 and import it again.');
  }
}

async function readBuild(roots: readonly Root[], root: Resolved, since?: number): Promise<CreateArtifactInput['files']> {
  const directory = root.virtual;
  const entry = await resolvePath(roots, `${directory}/index.html`);
  const entryStat = await fs.stat(entry.real);
  if (!entryStat.isFile()) throw new Error('ARTIFACT_BUILD_INVALID: The build must contain index.html.');
  if (since !== undefined && entryStat.mtimeMs < since - 2_000) return [];
  const files: CreateArtifactInput['files'] = [];
  let bytes = 0, scanned = 0;
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (depth > 8) throw new Error('Build output nesting exceeds the preview limit');
    const current = await resolvePath(roots, folder ? `${directory}/${folder}` : directory);
    const listing = await fs.opendir(current.real);
    for await (const item of listing) {
      if (++scanned > MAX_FILES * 2) throw new Error('Build output exceeds the preview file limit');
      const relative = folder ? `${folder}/${item.name}` : item.name;
      if (item.isDirectory()) { await walk(relative, depth + 1); continue; }
      if (item.isFile() && /\.(?:map|license\.txt)$/i.test(item.name)) continue;
      if (!item.isFile() || !/\.(?:html?|[cm]?js|css|svg|json|txt)$/i.test(item.name) || files.length >= MAX_FILES)
        throw new Error(`ARTIFACT_BUILD_UNSUPPORTED: Cannot import ${relative}. Use a standalone HTML build with text files and inline binary assets.`);
      const file = await resolvePath(roots, `${directory}/${relative}`);
      if (path.relative(root.real, file.real) !== relative.split('/').join(path.sep))
        throw new Error('Build file moved outside its original directory');
      const data = await readBuildFile(roots, file, MAX_BUNDLE - bytes);
      files.push(decodeBuildFile(relative, data));
      bytes += data.length;
    }
  };
  await walk('', 0);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

type HtmlNode = DefaultTreeAdapterTypes.Node;

function unsupported(detail: string): never {
  throw new Error(`ARTIFACT_BUILD_UNSUPPORTED: ${detail} The preview is offline. Bundle JavaScript into one file and inline binary and network assets.`);
}

async function validateBuild(files: CreateArtifactInput['files'], html: string): Promise<string> {
  const byPath = new Map(files.map(file => [file.path, file.text]));
  const source = (reference: string, extension: RegExp): string => {
    const raw = reference.trim();
    if (!raw || raw.startsWith('//') || raw.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(raw))
      unsupported('The build refers to an external or unsupported resource.');
    const relative = path.posix.normalize(raw.split(/[?#]/, 1)[0]!.replace(/^\//, ''));
    if (!extension.test(relative) || !byPath.has(relative)) unsupported(`Missing or unsupported build resource ${relative.slice(0, 120)}.`);
    return byPath.get(relative)!;
  };
  const checkCss = (css: string): void => {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    if (/@import\b/i.test(text) || [...text.matchAll(/url\(\s*['"]?([^'")\s]+)/gi)].some(match => !/^(?:data:|#)/i.test(match[1]!)))
      unsupported('A stylesheet uses an external import or a URL that is not inlined.');
  };
  await init;
  let title = '';
  const visit = (node: HtmlNode): void => {
    if ('tagName' in node) {
      const attr = (name: string) => node.attrs.find(item => item.name === name)?.value;
      const text = node.childNodes.map(child => 'value' in child ? child.value : '').join('');
      switch (node.tagName) {
        case 'title': title ||= text.trim().slice(0, 200); break;
        case 'script': {
          const type = (attr('type') ?? '').trim().toLowerCase();
          if (type === 'importmap') unsupported('Import maps are unavailable in the artifact preview.');
          const script = attr('src');
          if (script !== undefined || type === 'module') {
            const code = script !== undefined ? source(script, /\.[cm]?js$/i) : text;
            if (type === 'module') {
              const [imports] = parseModule(code);
              if (imports.length) unsupported('A module uses imports, split chunks or import.meta.');
            }
          }
          break;
        }
        case 'link': {
          const rel = (attr('rel') ?? '').toLowerCase().split(/\s+/);
          if (rel.includes('modulepreload')) unsupported('The build uses module preload or split chunks.');
          if (rel.includes('stylesheet')) checkCss(source(attr('href') ?? '', /\.css$/i));
          break;
        }
        case 'style': checkCss(text); break;
        case 'img': {
          const src = attr('src');
          if (attr('srcset')) unsupported('The build uses a responsive image source set.');
          if (src && !src.startsWith('data:')) source(src, /\.svg$/i);
          break;
        }
        case 'audio':
        case 'video':
        case 'source':
          if (attr('src') && !attr('src')!.startsWith('data:')) unsupported('A media source is not inlined.');
          break;
        case 'iframe':
        case 'object':
        case 'embed':
        case 'base':
          unsupported(`The build depends on a ${node.tagName} element.`);
      }
      const style = attr('style');
      if (style) checkCss(style);
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
  };
  visit(parse(html));
  return title;
}

export async function importWebBuild(input: Pick<CreateArtifactInput, 'sessionId' | 'projectId' | 'origin' | 'presentationId'> & {
  path: string; roots: readonly Root[]; current: () => Promise<boolean>; title?: string; since?: number;
}): Promise<Awaited<ReturnType<typeof createArtifact>> | null> {
  const approved = await resolvePath(input.roots, input.path);
  const stat = await fs.stat(approved.real);
  const filename = path.basename(approved.real);
  if (!stat.isDirectory() && (input.since !== undefined || !stat.isFile() || !/\.html?$/i.test(filename)))
    throw new Error('ARTIFACT_BUILD_INVALID: Choose a standalone HTML file or a build directory containing index.html.');
  const entrypoint = stat.isDirectory() ? 'index.html' : filename;
  // A file import reads only the chosen HTML. A build directory is the explicit
  // boundary for retaining related assets and never expands to an arbitrary parent.
  const files = stat.isDirectory() ? await readBuild(input.roots, approved, input.since)
    : [decodeBuildFile(entrypoint, await readBuildFile(input.roots, approved, MAX_FILE))];
  if (!files.length && input.since !== undefined) return null;
  const entry = files.find(file => file.path === entrypoint);
  if (!entry) throw new Error('ARTIFACT_BUILD_INVALID: The build must contain index.html.');
  const title = await validateBuild(files, entry.text);
  const live = getConfig(), caps = effectiveCapabilities(live);
  if (!caps.read || !caps.create || (await resolvePath(live.roots, input.path)).real !== approved.real || !await input.current())
    throw new Error('ARTIFACT_IMPORT_REVOKED: The chat or its Read and Create permissions changed during import.');
  return createArtifact({
    sessionId: input.sessionId, projectId: input.projectId, origin: input.origin, presentationId: input.presentationId,
    title: input.title ?? (title || 'Built web preview'), kind: 'web', entrypoint: entry.path, files, source: 'filesystem'
  });
}
