// Full production renderer with a durable-save fixture. No real accounts or installed profile.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), built = path.join(root, 'out/renderer'), output = path.join(root, 'outputs/provider-switching');
const version = require('../package.json').version;
const { fixtureConfigSource } = require('./fixtures/app-defaults.cjs');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const fixture = `${fixtureConfigSource()}
    const state={config:fixtureConfig({roots:[{name:'fixture',path:'/fixture/project'}],ui:{lastSeenVersion:'${version}',chatBrowser:'brave'},multiAgent:{enabled:false}}),hasApiKey:true,hasGoalKey:false,
      status:{state:'connected',detail:'',health:null,surfaces:[{id:'core',connectorName:'OneCode Core',description:'Core',cardSummary:'Local tools',optional:false,available:true,tools:['read'],state:'live',detail:'',localUrl:null,publicUrl:null,lastRequestAt:1,lastToolCallAt:1}]},
      connectorSchemas:{core:'fixture'},connectorRefresh:{core:{schemaId:'fixture',state:'current'}},
      bridge:{running:true,paired:true,present:true,extensionVersion:'${version}',externalExtension:{present:true,version:'${version}',signedIn:null}},update:{current:'${version}',latest:null,stage:'idle',checkedAt:1,error:null}};
    const ok=data=>Promise.resolve({ok:true,data});let listener=()=>{};window.saves=[];window.fixtureState=state;
    window.api=new Proxy({getState:()=>ok(state),getLog:()=>ok([]),listProjects:()=>ok([]),listSessions:()=>ok({sessions:[],activeId:null,pressure:[]}),listInputs:()=>ok([]),runningTools:()=>ok([]),listPausedHelpers:()=>ok([]),getSwarm:()=>ok({running:false,agents:[],pendingReports:0}),getChatModels:()=>ok({state:'unknown',models:[],requestedAt:null,observedAt:null}),
      onStateChanged:fn=>{listener=fn;return()=>{}},saveSettings:patch=>{window.saves.push(patch.ui.chatProvider);Object.assign(state.config,patch);return ok(structuredClone(state))}},
      {get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:()=>ok(null)});`;
  const server=http.createServer((request,response)=>{
    const pathname=new URL(request.url,'http://127.0.0.1').pathname;
    if(pathname==='/fixture.js'){response.setHeader('Content-Type','text/javascript');response.end(fixture);return;}
    const file=path.resolve(built,'.'+(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(built+path.sep)||!fs.existsSync(file)){response.writeHead(404);response.end();return;}
    const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)];if(type)response.setHeader('Content-Type',type);
    const data=fs.readFileSync(file);response.end(path.extname(file)==='.html'?data.toString().replace('<head>','<head><script src="/fixture.js"></script>'):data);
  });
  let win;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));fs.mkdirSync(output,{recursive:true});
    win=new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{offscreen:true,sandbox:true}});
    const errors=[]; win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message)});
    const js=expression=>win.webContents.executeJavaScript(expression);
    const until=async expression=>{const end=Date.now()+10000;while(Date.now()<end){if(await js(expression))return;await new Promise(resolve=>setTimeout(resolve,40));}throw Error('Timeout '+expression+'; errors '+errors.join(';'));};
    await win.loadURL('http://127.0.0.1:'+server.address().port);await until(`document.getElementById('providerBrowserTitle').textContent==='Gemini browser'`);
    await js(`document.getElementById('chatProvider').value='chatgpt';document.getElementById('chatProvider').dispatchEvent(new Event('change',{bubbles:true}))`);
    await until(`document.getElementById('providerBrowserTitle').textContent==='ChatGPT browser'`);
    assert.deepEqual(await js('window.saves'),['chatgpt']);
    const check=await js(`({provider:fixtureState.config.ui.chatProvider,setup:document.getElementById('setupChatProvider').value,skillHidden:document.getElementById('geminiSkillSetup').hidden,browserHint:document.getElementById('providerBrowserHint').textContent,step:document.getElementById('extensionStepChatGpt').textContent,link:document.getElementById('setupProviderPluginsOpen').dataset.link,guide:document.getElementById('pluginMoves').textContent,refreshHidden:document.getElementById('autoRefreshPluginsRow').hidden})`);
    assert.equal(check.provider,'chatgpt');assert.equal(check.setup,'chatgpt');assert.equal(check.skillHidden,true);assert.equal(check.refreshHidden,false);
    assert.match(check.browserHint,/ChatGPT/);assert.match(check.step,/ChatGPT/);assert.equal(check.link,'https://chatgpt.com/plugins');assert.match(check.guide,/Server URL/);assert.doesNotMatch(check.guide,/Gemini Connected/);
    await js(`document.querySelector('#tabs [data-tab="setup"]').click()`);
    for (const width of [1280, 920, 720]) {
      win.setSize(width, 1000);
      await new Promise(resolve => setTimeout(resolve, 100));
      const layout = await js(`(() => {
        const header = document.querySelector('.browser-setup-header');
        const rect = element => { const r = element.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; };
        return {setting:rect(header.querySelector('.setting')), phases:rect(header.querySelector('.browser-phases')), title:rect(header.querySelector('h3'))};
      })()`);
      assert.ok(layout.setting.height > 0, 'Provider selector is visible');
      assert.ok(layout.phases.y >= layout.setting.bottom, `Provider selector overlaps setup phases at ${width}px`);
      if (layout.title.height > 0) assert.ok(layout.title.y >= layout.phases.bottom, `Setup heading overlaps phases at ${width}px`);
    }
    win.setSize(1280, 1000);
    await js(`document.getElementById('setupChatProvider').value='gemini';document.getElementById('setupChatProvider').dispatchEvent(new Event('change',{bubbles:true}))`);
    await until(`document.getElementById('providerBrowserTitle').textContent==='Gemini browser'`);
    assert.deepEqual(await js('window.saves'),['chatgpt','gemini']);assert.equal(await js(`document.getElementById('geminiSkillSetup').hidden`),false);
    await js(`document.getElementById('chatBrowser').value='chrome';document.getElementById('chatBrowser').dispatchEvent(new Event('change',{bubbles:true}))`);
    await until(`fixtureState.config.ui.chatBrowser==='chrome'`);
    assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,...check,browserSave:true}));
  } finally {win?.destroy();server.close();app.quit();}
}).catch(error=>{console.error(error);app.exit(1);});
