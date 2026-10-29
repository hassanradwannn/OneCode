import { transform } from 'sucrase';
import type { ArtifactFile } from '../shared/artifact.js';

const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const script = (value: string): string => `<script>${value.replace(/<\/script/gi, '<\\/script')}</script>`;
const literal = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

/** Compile syntax only. Artifact code executes exclusively in the opaque preview. */
export async function reactPreview(files: ArtifactFile[], entrypoint: string): Promise<{ body: string; head: string }> {
  const failure = (message: string) => ({ body: `<p role="alert">${escape(message)} The original files remain available in the editor.</p>`, head: '' });
  if (files.length > 128 || files.reduce((sum, file) => sum + file.text.length, 0) > 1_500_000)
    return failure('Component source exceeds the preview limit.');
  const definitions: string[] = [];
  let icons = false, charts = false;
  for (const file of files) {
    if (/\.css$/i.test(file.path)) {
      definitions.push(`${literal(file.path)}:function(module){const style=document.createElement('style');style.textContent=${literal(file.text)};document.head.append(style);module.exports={};}`);
      continue;
    }
    if (/\.json$/i.test(file.path)) {
      try { definitions.push(`${literal(file.path)}:function(module){module.exports=${literal(JSON.parse(file.text))};}`); }
      catch { return failure(`Invalid JSON in ${file.path}.`); }
      continue;
    }
    if (!/\.(?:[cm]?js|jsx|tsx?)$/i.test(file.path)) continue;
    try {
      const code = transform(file.text, { filePath: file.path, production: true,
        transforms: /\.tsx?$/i.test(file.path) ? ['typescript', 'jsx', 'imports'] : ['jsx', 'imports'] }).code;
      icons ||= /["']lucide-react["']/.test(code);
      charts ||= /["']recharts["']/.test(code);
      definitions.push(`${literal(file.path)}:function(module,exports,require){${code}\n}`);
    } catch { return failure(`The component syntax in ${file.path} could not be compiled.`); }
  }
  if (!definitions.length) return failure('No component entrypoint is available.');
  const { default: runtime } = await import('virtual:onecode-artifact-runtime');
  const css = `@layer theme, base, components, utilities; @layer theme {${runtime.theme}} @layer base {${runtime.preflight}} @tailwind utilities;`;
  const boot = `(()=>{
    const factories={${definitions.join(',')}};const cache=Object.create(null);const libraries=window.__artifactLibraries;
    window.React=libraries.react;
    const load=(id,from='')=>{
      if(Object.prototype.hasOwnProperty.call(libraries,id))return libraries[id];
      if(!id.startsWith('.')&&!Object.prototype.hasOwnProperty.call(factories,id))throw Error('Preview package unavailable: '+id);
      const parts=id.startsWith('.')?from.split('/').slice(0,-1):[];
      for(const part of id.split('/')){if(!part||part==='.')continue;if(part==='..'){if(!parts.length)throw Error('Preview import leaves the artifact');parts.pop()}else parts.push(part)}
      const base=parts.join('/');const path=[base,...['.tsx','.jsx','.ts','.js','.json','/index.tsx','/index.jsx','/index.ts','/index.js'].map(ext=>base+ext)].find(path=>Object.prototype.hasOwnProperty.call(factories,path));
      if(!path)throw Error('Preview file unavailable: '+id);
      if(cache[path])return cache[path].exports;
      const module={exports:{}};cache[path]=module;factories[path](module,module.exports,id=>load(id,path));return module.exports;
    };
    const fail=error=>{console.error(String(error));const node=document.createElement('p');node.setAttribute('role','alert');node.textContent='Preview unavailable: '+String(error?.message||error);document.getElementById('root').replaceChildren(node)};
    window.addEventListener('error',event=>fail(event.error||event.message));window.addEventListener('unhandledrejection',event=>fail(event.reason));
    (async()=>{try{
      const compiler=await window.__artifactCompileCSS(${literal(css)});
      const style=document.createElement('style');document.head.append(style);const candidates=new Set();let scheduled=false;
      const update=()=>{scheduled=false;for(const node of document.querySelectorAll('[class]'))for(const token of node.classList){if(candidates.size<20000&&token.length<=512)candidates.add(token)}style.textContent=compiler.build([...candidates])};
      new MutationObserver(()=>{if(!scheduled){scheduled=true;queueMicrotask(update)}}).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});update();
      const entry=load(${literal(entrypoint)});const component=entry.default||entry.App;
      if(typeof component!=='function'&&typeof component!=='object')throw Error('Export a default component or App');
      libraries['react-dom/client'].createRoot(document.getElementById('root')).render(libraries.react.createElement(component));
    }catch(error){fail(error)}})();
  })();`;
  return { body: '<div id="root"></div>' + script(runtime.react) + (icons ? script(runtime.icons) : '') +
    (charts ? script(runtime.charts) : '') + script(runtime.tailwind) + script(boot),
    head: '<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{min-height:100%;margin:0;background:white;color:#202124;font-family:system-ui,sans-serif}[role=alert]{padding:20px;white-space:pre-wrap}</style>' };
}
