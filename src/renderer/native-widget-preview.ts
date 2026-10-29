/** Local styling for the public native widget vocabulary. No provider runtime,
 * remote stylesheet, script, font or privileged bridge is imported. Authored
 * HTML/SVG remains the retained source; unavailable runtime calls stay errors. */
export function nativeWidgetStyle(dark: boolean): string {
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
  return `<style>html{color-scheme:${dark ? 'dark' : 'light'};background:${dark ? '#191919' : '#fff'};color:${dark ? '#eee' : '#222'};font:14px/1.5 system-ui,sans-serif}body{margin:0;padding:12px}svg{max-width:100%;height:auto}svg text{font-family:system-ui,sans-serif;fill:${dark ? '#eee' : '#222'}}.t,.th{font-size:14px;font-weight:400}.th{font-weight:500}.ts{font-size:12px;font-weight:400;fill:${dark ? '#c3c2b7' : '#666'}}.arr{fill:none;stroke:${dark ? '#898781' : '#777'};stroke-width:1.5}${palette}</style>`;
}
