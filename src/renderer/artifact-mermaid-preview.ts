import mermaidRuntime from '@mermaid-js/tiny/dist/mermaid.tiny.js?raw';

export const diagramStyle = '<style>html{font:14px/1.5 Arial,sans-serif;color:#202124;background:#fff}body{margin:0;padding:16px}#diagram{overflow:auto}#diagram>svg{display:block;max-width:none;margin:0 auto}details{margin-top:16px}summary{cursor:pointer;color:#555}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,monospace}[role=alert]{color:#a32121}</style>';

export function diagramBody(text: string): string {
  const source = JSON.stringify(text).replace(/</g, '\\u003c');
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const render = `(async()=>{const host=document.getElementById('diagram'),status=document.getElementById('status');try{
    const source=JSON.parse(document.getElementById('diagram-source').textContent);
    if(source.length>50000)throw Error('Diagram source exceeds the 50,000 character preview limit.');
    mermaid.initialize({startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,maxTextSize:50000,maxEdges:500,
      htmlLabels:false,fontFamily:'Arial, sans-serif',flowchart:{htmlLabels:false},
      secure:['secure','securityLevel','startOnLoad','suppressErrorRendering','maxTextSize','maxEdges','htmlLabels','flowchart','fontFamily','themeCSS','dompurifyConfig']});
    const {svg}=await mermaid.render('onecode-diagram',source);
    const fragment=document.createElement('template');fragment.innerHTML=svg;
    for(const node of fragment.content.querySelectorAll('script,iframe,object,embed,foreignObject'))node.remove();
    for(const anchor of fragment.content.querySelectorAll('a'))anchor.replaceWith(...anchor.childNodes);
    for(const node of fragment.content.querySelectorAll('*'))for(const attr of [...node.attributes])
      if(/^on/i.test(attr.name)||(/^(?:href|xlink:href)$/i.test(attr.name)&&!attr.value.startsWith('#')))node.removeAttribute(attr.name);
    host.replaceChildren(fragment.content);host.dataset.state='ready';status.remove();
  }catch(error){host.replaceChildren();host.dataset.state='error';status.setAttribute('role','alert');status.textContent='Diagram could not be rendered. '+String(error?.message||error).slice(0,1000);document.getElementById('source-details').open=true;console.error('Diagram preview failed.');}})();`;
  return `<p id="status" role="status">Rendering diagram…</p><main id="diagram" aria-label="Diagram preview"></main><details id="source-details"><summary>Diagram source</summary><pre>${escaped}</pre></details><script id="diagram-source" type="application/json">${source}</script><script>${mermaidRuntime.replace(/<\/script/gi, '<\\/script')}\n${render}</script>`;
}
