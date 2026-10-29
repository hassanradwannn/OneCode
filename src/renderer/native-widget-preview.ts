/** Local styling for the public native widget vocabulary. No provider runtime,
 * remote stylesheet, script, font or privileged bridge is imported. Authored
 * HTML/SVG remains the retained source; unavailable runtime calls stay errors. */
export function widgetDiagramSize(source: string): { width: number; height: number } | null {
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  const nodes = [...parsed.body.children];
  if (nodes.length !== 1 || nodes[0]!.localName !== 'svg' || [...parsed.body.childNodes].some(node => node.nodeType === 3 && node.textContent?.trim())) return null;
  const svg = nodes[0]!, box = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const width = box.length === 4 ? box[2]! : Number(svg.getAttribute('width'));
  const height = box.length === 4 ? box[3]! : Number(svg.getAttribute('height'));
  return [width, height].every(value => Number.isFinite(value) && value > 0 && value <= 65536) ? { width, height } : null;
}

export function nativeWidgetStyle(dark: boolean, diagram = false): string {
  const colors = {
    gray: ['#f1efe8', '#444441', '#5f5e5a', '#b4b2a9', '#444441', '#d3d1c7'],
    blue: ['#e6f1fb', '#0c447c', '#185fa5', '#85b7eb', '#0c447c', '#b5d4f4'],
    green: ['#eaf3de', '#27500a', '#3b6d11', '#97c459', '#27500a', '#c0dd97'],
    amber: ['#faeeda', '#633806', '#854f0b', '#ef9f27', '#633806', '#fac775'],
    red: ['#fcebeb', '#791f1f', '#a32d2d', '#f09595', '#791f1f', '#f7c1c1'],
    coral: ['#faece7', '#712b13', '#993c1d', '#f0997b', '#712b13', '#f5c4b3']
  };
  const palette = Object.entries(colors).map(([name, c]) => {
    const fill = c[dark ? 1 : 0], stroke = c[dark ? 3 : 2], text = c[dark ? 5 : 4];
    return `.c-${name}>:is(rect,ellipse,circle,polygon),:is(rect,ellipse,circle,polygon).c-${name}{fill:${fill};stroke:${stroke}}.c-${name}>:is(.th,.t){fill:${text}}.c-${name}>.ts{fill:${stroke}}`;
  }).join('');
  const fit = diagram ? 'html,body{box-sizing:border-box;width:100%;height:100%;overflow:hidden}body{display:grid;place-items:center}body>svg{display:block;width:100%;height:100%;min-width:0;min-height:0;max-width:100%;max-height:100%}' : '';
  return `<style>html{color-scheme:${dark ? 'dark' : 'light'};background:${dark ? '#191919' : '#fff'};color:${dark ? '#eee' : '#222'};font:14px/1.5 system-ui,sans-serif}body{margin:0;padding:12px}svg{max-width:100%;height:auto}svg text{font-family:system-ui,sans-serif;fill:${dark ? '#eee' : '#222'}}.t,.th{font-size:14px;font-weight:400}.th{font-weight:500}.ts{font-size:12px;font-weight:400;fill:${dark ? '#c3c2b7' : '#666'}}.arr{fill:none;stroke:${dark ? '#898781' : '#777'};stroke-width:1.5}${palette}${fit}</style>`;
}
