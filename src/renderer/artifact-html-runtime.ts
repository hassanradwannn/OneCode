/** HTML artifacts use the same bundled compiler as component artifacts. The
 * runtime is text until it executes inside the opaque, network-closed frame. */
export async function htmlTailwindRuntime(): Promise<string> {
  const { default: runtime } = await import('virtual:onecode-artifact-runtime');
  const css = `@layer theme, base, components, utilities; @layer theme {${runtime.theme}} @layer base {${runtime.preflight}} @tailwind utilities;`;
  const input = JSON.stringify(css).replace(/</g, '\\u003c');
  return runtime.tailwind + `\n(async()=>{try{
    const compiler=await window.__artifactCompileCSS(${input});
    const style=document.createElement('style');style.dataset.onecodeTailwind='';document.head.append(style);
    const candidates=new Set();let scheduled=false;
    const update=()=>{scheduled=false;for(const node of document.querySelectorAll('[class]'))for(const token of node.classList){if(candidates.size<20000&&token.length<=512)candidates.add(token)}style.textContent=compiler.build([...candidates])};
    new MutationObserver(records=>{if(records.every(record=>record.target===style||style.contains(record.target)))return;if(!scheduled){scheduled=true;queueMicrotask(update)}}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
    update();
  }catch(error){console.error('Offline Tailwind preview failed: '+String(error?.message||error))}})();`;
}

export function isTailwindBrowserScript(source: string): boolean {
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && url.hostname === 'cdn.tailwindcss.com' &&
      !url.username && !url.password && !url.port && !url.search && !url.hash && url.pathname === '/';
  } catch { return false; }
}
