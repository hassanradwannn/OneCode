import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const virtual = 'virtual:onecode-artifact-runtime';
let cached: Promise<Record<string, string>> | undefined;

/** Trusted browser libraries become source text, never evaluated in the host renderer.
 * Both desktop and Remote inject the same offline runtime into their opaque iframe. */
export async function artifactRuntimeSources(): Promise<Record<string, string>> {
  return cached ??= (async () => {
    const sources: Record<string, string> = {
      react: 'import * as React from "react"; import * as ReactDOM from "react-dom"; import * as client from "react-dom/client"; import * as jsx from "react/jsx-runtime"; window.__artifactLibraries={react:React,"react-dom":ReactDOM,"react-dom/client":client,"react/jsx-runtime":jsx};',
      icons: 'import * as library from "lucide-react"; window.__artifactLibraries["lucide-react"]=library;',
      charts: 'import * as library from "recharts"; window.__artifactLibraries.recharts=library;',
      tailwind: 'import {compile} from "tailwindcss"; window.__artifactCompileCSS=compile;'
    };
    const output: Record<string, string> = {};
    for (const [name, contents] of Object.entries(sources)) {
      const result = await build({ stdin: { contents, resolveDir: process.cwd() }, bundle: true, write: false,
        format: 'iife', platform: 'browser', target: 'es2022', minify: true, legalComments: 'inline',
        define: { 'process.env.NODE_ENV': '"production"' },
        plugins: name === 'react' ? [] : [{ name: 'shared-preview-react', setup(builder) {
          builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: args.path, namespace: 'preview-react' }));
          builder.onLoad({ filter: /.*/, namespace: 'preview-react' }, args => ({ contents: `module.exports=window.__artifactLibraries[${JSON.stringify(args.path)}];`, loader: 'js' }));
        } }]
      });
      output[name] = result.outputFiles[0]!.text;
    }
    const root = path.dirname(require.resolve('tailwindcss/package.json'));
    output.theme = await readFile(path.join(root, 'theme.css'), 'utf8');
    output.preflight = await readFile(path.join(root, 'preflight.css'), 'utf8');
    return output;
  })();
}

export function artifactRuntimePlugin() {
  return { name: 'onecode-offline-artifact-runtime',
    resolveId(id: string) { return id === virtual ? '\0' + virtual : undefined; },
    async load(id: string) { return id === '\0' + virtual ? `export default ${JSON.stringify(await artifactRuntimeSources())};` : undefined; }
  };
}
