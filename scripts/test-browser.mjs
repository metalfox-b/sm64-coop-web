// Real game runtime, browser authentication and relay. No engine or network mocks.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createActivityServer, loadConfig } from '../server/main.mjs';
import { hashPassword } from '../server/browser-auth.mjs';
import { signSlot } from '../shared/save.mjs';

const engine=process.env.SM64_BROWSER||process.argv[2]||'chromium';
assert.ok(['chromium','webkit'].includes(engine));

const { [engine]: browserType }=await import('playwright');
const output=resolve(`evidence/browser-${engine}-${Date.now()}`);await mkdir(output,{recursive:true});
const config={...loadConfig({SM64_ENGINE:process.env.SM64_ENGINE,ENGINE_ROOT:process.env.ENGINE_ROOT}),port:0,browserSecureCookies:false,
  browserPasswordHash:await hashPassword('local-fixture-password'),browserSessionSecret:randomBytes(32).toString('base64url'),worldDatabase:resolve(output,'worlds.sqlite')};
let app=createActivityServer(config);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const port=app.server.address().port,base=`http://127.0.0.1:${port}`,clients=[],checks=[];
const mobile=engine==='webkit'||process.env.SM64_TOUCH==='1';
function muteAudio() {
  if(!globalThis.AudioNode)return;
  window.__audioContexts=[];
  for(const name of ['AudioContext','webkitAudioContext'])if(window[name]) {
    const Native=window[name];window[name]=class extends Native {constructor(...args){super(...args);window.__audioContexts.push(this);}};
  }
  const connect=AudioNode.prototype.connect,gains=new WeakMap();
  AudioNode.prototype.connect=function(destination,...ports){
    if(destination!==this.context.destination)return connect.call(this,destination,...ports);
    let gain=gains.get(this.context);if(!gain){gain=this.context.createGain();gain.gain.value=0;connect.call(gain,destination);gains.set(this.context,gain);}
    connect.call(this,gain,...ports);return destination;
  };
  Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[]});
}
async function open(name,code) {
  const context=await browserType.launchPersistentContext(resolve(output,name+'-profile'),{
    headless:process.env.SM64_HEADLESS==='1',viewport:process.env.SM64_PORTRAIT==='1'?{width:390,height:844}:mobile?{width:844,height:390}:{width:1280,height:720},hasTouch:mobile,
    ...(mobile?{userAgent:engine==='webkit'?'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/18.7 Mobile/15E148 Safari/604.1':'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36'}:{}),
    ...(engine==='chromium'?{args:['--mute-audio','--enable-webgl','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']}:{}),
  });
  await context.addInitScript(muteAudio);
  const page=context.pages()[0]||await context.newPage(),record={name,context,page,logs:[],errors:[],responses:[],assets:[]};clients.push(record);
  page.on('console',value=>{record.logs.push({type:value.type(),text:value.text()});if(process.env.SM64_DEBUG)console.log(value.text());});
  page.on('pageerror',error=>record.errors.push({message:error.message,stack:error.stack}));
  page.on('request',request=>{assert.equal(new URL(request.url()).origin,base,'game requests stay on the user host');assert.ok((request.postDataBuffer()?.length||0)<65536,'ROM is never uploaded');});
  page.on('response',response=>{if(response.url().includes('/api/engine/'))record.assets.push(response.url());if(response.status()>=400)record.responses.push({url:response.url(),status:response.status()});});
  await page.goto(base+(code?'/?lobby='+code:''));await page.locator('#password').waitFor({state:'visible'});
  await page.locator('#password').fill('local-fixture-password');await page.locator('#login-form button').click();
  await page.locator('#name').waitFor({state:'visible'});await page.locator('#name').fill(name);
  assert.equal(await page.evaluate(()=>Boolean(window.SM64Activity.module)),false,'sign-in must not launch automatically');
  await page.locator('#play').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Import your own'));
  assert.equal(await page.evaluate(()=>Boolean(window.SM64Activity.module)),false,'ROM required before joining');
  assert.ok(process.env.SM64_ROM,'Set SM64_ROM for the private browser fixture');
  await page.locator('#rom-lawful').check();
  await page.locator('#rom-file').setInputFiles(process.env.SM64_ROM);
  await page.waitForFunction(()=>document.querySelector('#rom-status').textContent.includes('ROM saved'));
  // Reload proves each separate browser profile retains its own ROM.
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#rom-status').textContent.includes('Your ROM is saved'));
  await page.locator('#name').fill(name);
  await page.locator('#play').click();console.log(name+' joining');
  try{await page.waitForFunction(()=>document.querySelector('#status').classList.contains('error')||window.SM64Activity?.module&&!window.SM64Activity.booting&&window.SM64Activity.diagnostics.level>0,{},{timeout:60000});
    assert.equal(await page.locator('#status').evaluate(element=>element.classList.contains('error')),false,await page.locator('#status').textContent());}
  catch(error){console.log(name+' startup failed: '+await page.locator('#status').textContent());throw error;}
  console.log(name+' running '+JSON.stringify(await page.evaluate(()=>window.SM64Activity.diagnostics)));
  return record;
}
async function closeService(){app.relay.close();await new Promise(resolve=>app.server.close(resolve));}
try {
  const host=await open('Host'),code=await host.page.evaluate(()=>window.SM64Activity.room.code);
  assert.equal(await host.page.evaluate(()=>crossOriginIsolated),false,'runtime must work without SharedArrayBuffer');
  await host.page.waitForTimeout(6500);
  const renderer=await host.page.evaluate(()=>{const c=document.querySelector('#canvas'),gl=c.getContext('webgl2')||c.getContext('webgl');const ext=gl?.getExtension('WEBGL_debug_renderer_info');return {api:gl?.constructor.name,renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl?.getParameter(gl.RENDERER),vendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):gl?.getParameter(gl.VENDOR)};});
  checks.push({check:'WebGL context',renderer});
  checks.push({check:'single-player runtime',diagnostics:await host.page.evaluate(()=>window.SM64Activity.diagnostics),timing:await host.page.evaluate(()=>window.SM64Activity.sample())});
  await host.page.screenshot({path:resolve(output,'host.png')});
  if(process.env.SM64_AUDIO_CHECK==='1')await (await import('./test-audio.mjs')).testAudio(host.page,output,checks);
  if(process.env.SM64_CONTROLS==='1')await (await import('./test-controls.mjs')).testControls(host.page,output,checks);
  if(process.env.SM64_BOOT_ONLY==='1'){assert.ok(clients.every(c=>!c.errors.length),'no browser errors');console.log(JSON.stringify(checks));}
  else {
    const client=await open('Friend',code);
    await Promise.all([host,client].map(({page})=>page.waitForFunction(()=>window.SM64Activity.diagnostics.players===2,{},{timeout:30000})));
    checks.push({check:'two native players',host:await host.page.evaluate(()=>window.SM64Activity.diagnostics),client:await client.page.evaluate(()=>window.SM64Activity.diagnostics)});
    const before=await client.page.evaluate(()=>window.SM64Activity.diagnostics.position);
    await client.page.keyboard.down('KeyW');await client.page.waitForTimeout(1200);await client.page.keyboard.up('KeyW');
    await client.page.waitForTimeout(2200);const after=await client.page.evaluate(()=>window.SM64Activity.diagnostics.position);
    assert.ok(Math.hypot(...after.map((value,index)=>value-before[index]))>20,'Mario responds to browser movement');
    checks.push({check:'movement',before,after});
    // Modify a real native EEPROM checkpoint to test durable star restore through
    // the production host callback. This is a fixture star, not gameplay earning.
    const bytes=Buffer.from(await host.page.evaluate(()=>Array.from(window.SM64Activity.module.FS.readFile('/coop/sm64_save_file.bin'))));
    bytes[12]|=1;signSlot(bytes.subarray(0,56));bytes.copy(bytes,56,0,56);
    await host.page.evaluate(bytes=>{const m=window.SM64Activity.module;m.FS.writeFile('/coop/sm64_save_file.bin',new Uint8Array(bytes));m._web_reload_save();m._web_save_snapshot();},[...bytes]);
    await Promise.all([host,client].map(({page})=>page.waitForFunction(()=>window.SM64Activity.room.world.stars>=1&&window.SM64Activity.diagnostics.stars>=1,{},{timeout:20000})));
    checks.push({check:'native checkpoint and shared stars',world:await host.page.evaluate(()=>window.SM64Activity.room.world)});
    const generation=await client.page.evaluate(()=>window.SM64Activity.room.generation);
    await host.context.close();
    await client.page.waitForFunction(generation=>window.SM64Activity.room.generation>generation&&window.SM64Activity.room.host===window.SM64Activity.self&&!window.SM64Activity.booting&&window.SM64Activity.diagnostics.networkType===1&&(window.SM64Activity.diagnostics.backend!=='rust'||window.SM64Activity.diagnostics.simulationTicks>2),generation,{timeout:30000}).catch(async error=>{console.log('migration: '+JSON.stringify(await client.page.evaluate(()=>({room:window.SM64Activity.room,diagnostics:window.SM64Activity.diagnostics,status:document.querySelector('#status').textContent}))));throw error;});
    assert.ok(await client.page.evaluate(()=>window.SM64Activity.diagnostics.stars>=1));
    checks.push({check:'host migration',diagnostics:await client.page.evaluate(()=>window.SM64Activity.diagnostics)});
    await client.page.screenshot({path:resolve(output,'migrated.png')});
    await client.context.close();await closeService();
    app=createActivityServer({...config,port});await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
    const restored=await open('Restored',code);
    await restored.page.waitForFunction(()=>window.SM64Activity.diagnostics.stars>=1,{},{timeout:20000});
    checks.push({check:'server restart and same invite restores stars',diagnostics:await restored.page.evaluate(()=>window.SM64Activity.diagnostics)});
    await restored.page.screenshot({path:resolve(output,'restored.png')});
    assert.ok(clients.every(client=>!client.errors.length),'no uncaught browser errors');
    assert.ok(clients.every(client=>!client.logs.some(value=>/WebGL.*INVALID_(?:OPERATION|VALUE|ENUM)/.test(value.text))),'no WebGL rendering errors');
    console.log(JSON.stringify(checks));
  }
} finally {
  await writeFile(resolve(output,'result.json'),JSON.stringify({engine,mobile,checks,clients:clients.map(({name,logs,errors,responses,assets})=>({name,logs,errors,responses,assets})),scope:'Local desktop browser fixture. Mobile viewports do not establish physical phone FPS or live Discord support.'},null,2));
  for(const client of clients)await client.context.close().catch(()=>{});
  await closeService().catch(()=>{});console.log('Evidence: '+output);
}
