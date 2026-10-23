import path from 'node:path';

type NativePackages = {
  sharp: typeof import('sharp').default;
  'tree-sitter': typeof import('tree-sitter');
  'tree-sitter-bash': typeof import('tree-sitter-bash');
  'node-pty': typeof import('node-pty');
};

/** Native packages belong to the complete runtime, including their unpacked JavaScript.
 * A verified Linux application layer has no adjacent immutable app.asar.unpacked tree. */
export function loadNativePackage<K extends keyof NativePackages>(name: K): NativePackages[K] {
  const layer = (globalThis as typeof globalThis & { __onecodeApplicationLayer?: { appAsar: string } }).__onecodeApplicationLayer;
  const owner = process.platform === 'linux' && layer
    ? path.join(process.resourcesPath, 'app.asar', 'package.json')
    : typeof __filename === 'string' ? __filename : import.meta.url;
  // Do not add another external module import to the immutable bootstrap's bundle graph.
  const requireOwner = process.getBuiltinModule('node:module').createRequire(owner);
  return requireOwner(name) as NativePackages[K];
}
