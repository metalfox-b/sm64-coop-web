import {validateROM,loadROM,saveROM,forgetROM,ROM_BYTES} from './rom.mjs';
import { DiscordSDK } from '@discord/embedded-app-sdk';
import { createInput } from './input.mjs';
import { createGraphics, displaySize } from './graphics.mjs';

const $=id=>document.getElementById(id),canvas=$('canvas');
const insideDiscord=window.parent!==window&&new URLSearchParams(location.search).has('frame_id');
const api=path=>(location.hostname.endsWith('.discordsays.com')?'/.proxy':'')+path;
const asset=path=>{const url=new URL(path,import.meta.url);url.search=new URL(import.meta.url).search;return url.href;};
let localROM=null;
let sdk,config,socket,room,self,session,module,booting=false,leaving=false,connecting=false,createWorld=true,runtimeGeneration=0,filesPromise,input;
let lastCheckpoint='',pendingCheckpoint='',checkpointTimer,lastSent=0,latestDiagnostics={},noticeTimer,reconnecting=false;
const prefs={sensitivity:1,invertY:false,quality:'auto',mute:false};
try{const saved=JSON.parse(localStorage.getItem('sm64-controls')||'null');if(saved){
  if(Number.isFinite(saved.sensitivity))prefs.sensitivity=Math.min(2,Math.max(.25,saved.sensitivity));
  prefs.invertY=saved.invertY===true;prefs.mute=saved.mute===true;
  if(['auto','performance','balanced','high'].includes(saved.quality))prefs.quality=saved.quality;
}}catch{}
let mobile=matchMedia('(pointer: coarse)').matches||/Android|iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const graphics=createGraphics({mobile,onChange:resize,inactive:()=>document.hidden||booting||!module,quality:()=>prefs.quality});
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
function notice(message){$('notice').textContent=message;$('notice').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('notice').hidden=true,4500);}
async function request(path,value) {
  const response=await fetch(api(path),value===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not connect to the server');return data;
}
function showLauncher(message){$('launcher').hidden=false;status(message);$('progress').hidden=true;$('lobby-form').hidden=false;$('play').disabled=false;}
function parseCode(value){const text=value.trim();try{return new URL(text).searchParams.get('lobby')||text;}catch{return text;}}
const inviteCode=new URLSearchParams(location.search).get('lobby')||sessionStorage.getItem('sm64-last-lobby')||'';
if(inviteCode){createWorld=false;$('code').value=inviteCode;}
function tabs(create){createWorld=create;$('create-tab').classList.toggle('selected',create);$('join-tab').classList.toggle('selected',!create);$('world-label').hidden=!create;$('code-label').hidden=create;}
tabs(createWorld);$('create-tab').onclick=()=>tabs(true);$('join-tab').onclick=()=>tabs(false);
try{$('name').value=localStorage.getItem('sm64-name')||'Player';}catch{}
$('login-form').onsubmit=async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;
  try{await request('/api/browser/login',{password:$('password').value,name:$('name').value});$('password').value='';$('login-form').hidden=true;$('lobby-form').hidden=false;status('Choose your name and enter a world.');}
  catch(error){status(error.message,true);}finally{button.disabled=false;}
};
$('lobby-form').onsubmit=event=>{event.preventDefault();void join().catch(error=>{connecting=false;showLauncher(error.message);status(error.message,true);});};
async function authorize() {
  if(insideDiscord) {
    const {code}=await sdk.commands.authorize({client_id:config.clientId,response_type:'code',state:crypto.randomUUID(),prompt:'none',scope:['identify']});
    const value=await request('/api/session',{code,instanceId:sdk.instanceId});
    await sdk.commands.authenticate({access_token:value.accessToken});return value;
  }
  return request('/api/browser/lobby',{create:createWorld,worldName:$('world-name').value,code:parseCode($('code').value),name:$('name').value});
}
async function join() {
  if(!localROM)throw new Error('Import your own lawfully obtained ROM first.');
  if(connecting)return;connecting=true;leaving=false;$('play').disabled=true;status('Joining your world…');
  try{localStorage.setItem('sm64-name',$('name').value);}catch{}
  session=await authorize();
  sessionStorage.setItem('sm64-last-lobby',session.lobby.code);createWorld=false;$('code').value=session.lobby.code;tabs(false);
  const url=new URL(api('/relay'),location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
  socket=new WebSocket(url);socket.binaryType='arraybuffer';
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{socket.close();reject(new Error('The lobby did not respond. Try joining again.'));},15000);
    socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'join',ticket:session.ticket})),{once:true});
    socket.addEventListener('message',event=>{
      if(typeof event.data==='string') {
        let value;try{value=JSON.parse(event.data);}catch{return;}
        if(value.type==='welcome'){clearTimeout(timer);self=value.self;updateRoom(value);resolve();}
        else if(value.type==='room')updateRoom(value);
        else if(value.type==='saved')updateWorld(value.world);
      }else receive(event.data);
    });
    socket.addEventListener('error',()=>{});
    socket.addEventListener('close',event=>{
      clearTimeout(timer);reject(new Error(event.reason||'Lobby connection closed'));
      if(leaving)return;
      void stopRuntime();
      if(event.code===4001){showLauncher('This player joined in another window.');return;}
      if(event.code===1008){showLauncher(event.reason||'Your session ended. Sign in and join again.');return;}
      void reconnect();
    },{once:true});
  });
  connecting=false;reconnecting=false;
}
async function reconnect() {
  if(reconnecting||leaving)return;reconnecting=true;status('Reconnecting to your saved world…');$('launcher').hidden=false;
  for(let attempt=0;attempt<5&&!leaving;attempt++) {
    await new Promise(resolve=>setTimeout(resolve,Math.min(5000,750*2**attempt)));
    try{connecting=false;await join();return;}catch{}
  }
  reconnecting=false;connecting=false;showLauncher('Your world is saved. Join again to continue.');
}
function updateRoom(value) {
  const changed=room&&value.generation!==room.generation;
  room=value;$('lobby-title').textContent=value.name;$('players').textContent=`${value.players.length}/${value.maxPlayers} players`;
  $('save-status').textContent=`★ ${value.world.stars} · Saved`;
  if(!module&&!booting||changed)void launchRuntime().catch(fatal);
}
function updateWorld(world) {
  if(!room||world.revision<room.world.revision)return;
  const changed=room.world.save!==world.save;room.world=world;
  $('save-status').textContent=`★ ${world.stars} · Saved`;
  if(changed&&module&&!booting&&world.save) {
    const bytes=Uint8Array.from(atob(world.save),char=>char.charCodeAt(0));
    module.FS.writeFile('/coop/sm64_save_file.bin',bytes);lastCheckpoint=world.save;module._web_reload_save();
  }
}
async function fetchBytes(name) {
  const response=await fetch(api('/api/engine/'+name),{headers:{authorization:`Bearer ${session.dataToken}`}});
  if(!response.ok)throw new Error(`Could not load the game (${response.status}). Rejoin the lobby to try again.`);
  return response.arrayBuffer();
}
async function files() {
  if(!localROM)throw new Error('Each player must import their own lawfully obtained ROM before joining.');
  if(!filesPromise)filesPromise=Promise.all([fetchBytes('sm64.wasm'),fetchBytes('shell.data'),import(asset('./engine/sm64.js'))])
    .then(([wasm,data,engine])=>({wasm,data,create:engine.default})).catch(error=>{filesPromise=null;throw error;});
  return filesPromise;
}
async function stopRuntime() {
  ++runtimeGeneration;booting=false;const previous=module;module=null;
  input?.reset();clearTimeout(checkpointTimer);pendingCheckpoint='';
  if(previous){previous.coopBridge.stopping=true;try{previous._web_stop();}catch{}}
  document.body.classList.remove('playing','native-menu');$('star-menu').hidden=true;$('game-bar').hidden=true;$('touch-controls').hidden=true;
}
async function launchRuntime() {
  await stopRuntime();const generation=runtimeGeneration;booting=true;$('launcher').hidden=false;$('progress').hidden=false;status('Loading your world…');
  const loaded=await files();if(generation!==runtimeGeneration)return;
  const host=room.host,id=self;
  const bridge={id,host,name:$('name').value,stopping:false,
    get peers(){return (room?.players||[]).map(player=>player.id);},
    send(target,bytes){if(bridge.stopping||socket?.readyState!==WebSocket.OPEN||socket.bufferedAmount>128*1024)return false;
      const frame=new Uint8Array(bytes.length+8);new DataView(frame.buffer).setUint32(4,target,true);frame.set(bytes,8);socket.send(frame);return true;},
    save(bytes){if(bridge.stopping||id!==room.host)return;pendingCheckpoint=btoa(String.fromCharCode(...bytes));scheduleCheckpoint();},
    presented(){if(bridge.stopping)return;graphics.presented();},
    diagnostics(value){latestDiagnostics=value;},
    leave(){void leaveLobby();},
    hud(v){const values={'hud-lives':v.flags&1?`M × ${v.lives}`:'','hud-coins':v.flags&2?`● ${v.coins}`:'','hud-stars':v.flags&4?`★ ${v.stars}`:'','hud-health':v.flags&0x108?`♥ ${v.health}/8`:'','hud-timer':v.flags&64?`${Math.floor(v.timer/1800)}:${String(Math.floor(v.timer/30)%60).padStart(2,'0')}`:'','hud-cap':v.cap>0?`Cap ${Math.ceil(v.cap/30)}s`:''};for(const [id,text]of Object.entries(values)){if($(id).textContent!==text)$(id).textContent=text;$(id).hidden=!text;}},
  };
  const instance=await loaded.create({canvas,coopBridge:bridge,noInitialRun:true,wasmBinary:loaded.wasm,
    getPreloadedPackage:()=>loaded.data.slice(0),locateFile:name=>api('/api/engine/'+name),
    print:text=>console.info('[SM64]',text),printErr:text=>console.warn('[SM64]',text),onAbort:error=>fatal(new Error(String(error)))});
  if(generation!==runtimeGeneration){bridge.stopping=true;return;}
  instance.FS.writeFile('/coop/player.z64',new Uint8Array(localROM));
  module=instance;
  if(room.world.save){instance.FS.writeFile('/coop/sm64_save_file.bin',Uint8Array.from(atob(room.world.save),char=>char.charCodeAt(0)));lastCheckpoint=room.world.save;}else {
    lastCheckpoint='';const blank=new Uint8Array(512);
    for(let slot=0;slot<8;slot++){blank[slot*56+52]=0x44;blank[slot*56+53]=0x41;blank[slot*56+55]=0x85;}
    instance.FS.writeFile('/coop/sm64_save_file.bin',blank);
  }
  instance.FS.writeFile('/coop/sm64config.txt',`bettercam_enable true\nbettercam_analog true\nbettercam_mouse_look true\nbettercam_collision true\nbettercam_centering true\nbettercam_inverty false\nskip_intro true\ncoop_stay_in_level_after_star 1\nwindow_w 960\nwindow_h 540\n`);
  const args=['--savepath','/coop','--hide-loading-screen','--skip-update-check','--skip-intro','--playername',insideDiscord?(room.players.find(p=>p.id===self)?.name||'Player'):$('name').value];
  if(self===host)args.push('--server','7777');else args.push('--client','relay','7777');
  // Install capture handlers before SDL registers its keyboard listeners.
  if(!input)input=createInput({canvas,touch:mobile,active:()=>Boolean(module),enabled:()=>Boolean(module&&!booting&&!$('settings').open),onMenu:openGameMenu,ui:()=>module?._web_ui_state?.()||0,pointer:(x,y,event)=>module?._web_pointer?.(x,y,event),action:value=>module?._web_action?.(value),airborne:()=>Boolean(module?._web_airborne?.()),sensitivity:()=>prefs.sensitivity,invert:()=>prefs.invertY});
  else if(mobile)$('touch-controls').hidden=false;
  instance.callMain(args);instance._web_mute(prefs.mute?1:0);booting=false;resize();
  document.body.classList.add('playing');$('launcher').hidden=true;$('game-bar').hidden=false;canvas.focus();
  socket.send(JSON.stringify({type:'ready',background:document.hidden}));notice(mobile?'Left thumb moves. Right: drag to look, swipe ↑ to jump, tap to attack.':'Click the game to capture the mouse. Esc opens the game menu.');
}
function scheduleCheckpoint() {
  if(checkpointTimer)return;
  checkpointTimer=setTimeout(()=>{checkpointTimer=null;sendCheckpoint();},Math.max(50,300-(performance.now()-lastSent)));
}
function sendCheckpoint() {
  if(!pendingCheckpoint||pendingCheckpoint===lastCheckpoint||self!==room?.host||socket?.readyState!==WebSocket.OPEN)return;
  if(performance.now()-lastSent<300){scheduleCheckpoint();return;}
  lastCheckpoint=pendingCheckpoint;pendingCheckpoint='';lastSent=performance.now();
  $('save-status').textContent='Saving…';socket.send(JSON.stringify({type:'save',save:lastCheckpoint}));
}
async function flushCheckpoint() {
  module?._web_save_snapshot();
  if(pendingCheckpoint&&pendingCheckpoint!==lastCheckpoint)await new Promise(resolve=>setTimeout(resolve,Math.max(0,300-(performance.now()-lastSent))));
  sendCheckpoint();
}
function receive(buffer) {
  if(!module||booting||buffer.byteLength<=8||buffer.byteLength>=3008)return;
  const bytes=new Uint8Array(buffer),sender=new DataView(buffer).getUint32(0,true),pointer=module._malloc(bytes.length-8);
  module.HEAPU8.set(bytes.subarray(8),pointer);module._web_receive(sender,pointer,bytes.length-8);module._free(pointer);
}
function resize() {
  if(!module||booting)return;
  const rect=canvas.getBoundingClientRect();const size=displaySize(rect.width,rect.height,graphics.height);module._web_resize(size.width,size.height);
}
window.addEventListener('resize',resize);window.visualViewport?.addEventListener('resize',resize);
function openGameMenu(){if(!module||booting)return;input?.reset();void document.exitPointerLock?.();module._web_menu?.();}
$('menu-button').onclick=openGameMenu;
function openSettings(){if(!module)return;input?.reset();if($('settings').open){$('settings').close();return;}void document.exitPointerLock?.();$('settings').showModal();}
$('settings-button').onclick=openSettings;$('settings').addEventListener('close',()=>{input?.reset();canvas.focus();});
$('sensitivity').value=prefs.sensitivity;$('invert-y').checked=prefs.invertY;$('quality').value=prefs.quality;$('mute').checked=prefs.mute;
for(const id of ['sensitivity','invert-y','quality','mute'])$(id).oninput=()=>{
  prefs.sensitivity=Number($('sensitivity').value);prefs.invertY=$('invert-y').checked;prefs.quality=$('quality').value;prefs.mute=$('mute').checked;
  try{localStorage.setItem('sm64-controls',JSON.stringify(prefs));}catch{}module?._web_mute(prefs.mute?1:0);resize();
};
$('invite').onclick=async()=>{
  const origin=config.browserOrigin||(!insideDiscord?location.origin:'');
  const link=origin?`${origin}/?lobby=${room.code}`:room.code;
  try{await navigator.clipboard.writeText(link);notice(origin?'Browser invite copied.':'Lobby code copied.');}catch{notice(`Lobby code: ${room.code}`);}
};
async function leaveLobby(){leaving=true;await flushCheckpoint();socket?.close();void stopRuntime();$('settings').close();showLauncher('Your world is saved. Come back whenever you like.');}
$('leave').onclick=leaveLobby;
window.addEventListener('pagehide',()=>{leaving=true;module?._web_save_snapshot();sendCheckpoint();socket?.close();});
document.addEventListener('visibilitychange',async()=>{
  input?.reset();if(document.hidden)await flushCheckpoint();
  if(!leaving&&socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'presence',background:document.hidden}));
});
let wasMenu=0,lastHud=0,lastStars='';
function updateStars(menu){
  $('star-menu').hidden=menu!==4;if(menu!==4){lastStars='';return;}
  module._web_star_snapshot();const stars=module.webStars||[],key=JSON.stringify(stars);
  if(key===lastStars)return;lastStars=key;
  if($('star-options').children.length!==stars.length){$('star-options').replaceChildren(...stars.map(star=>{const b=document.createElement('button');b.type='button';b.onpointerenter=()=>module?._web_star_choose(star.index,0);b.onfocus=()=>module?._web_star_choose(star.index,0);b.onclick=()=>module?._web_star_choose(star.index,1);return b;}));}
  stars.forEach((star,i)=>{const b=$('star-options').children[i];b.textContent=`${star.collected?'★':'☆'} ${star.index+1} · ${star.label}`;b.disabled=!star.enabled;b.classList.toggle('selected',star.selected);b.setAttribute('aria-pressed',String(star.selected));});
}
function tick(){if(module&&!booting){const menu=module._web_ui_state?.()||0;
  if(menu!==wasMenu){input.reset();if(menu)void document.exitPointerLock?.();document.body.classList.toggle('native-menu',!!menu);wasMenu=menu;}
  module._web_input(...input.read());if(performance.now()-lastHud>100){lastHud=performance.now();module._web_hud_snapshot?.();updateStars(menu);}}requestAnimationFrame(tick);}requestAnimationFrame(tick);
setInterval(()=>{if(module&&!booting){module._web_diagnostics();module._web_save_snapshot();const sample=graphics.sample();$('metrics').textContent=`${sample.fps.toFixed(0)} FPS · ${sample.renderHeight}p`; }},2000);
function fatal(error){leaving=true;socket?.close();void stopRuntime();connecting=false;showLauncher('Could not start the game.');status(error.message||String(error),true);console.error(error);}
window.SM64Activity={get diagnostics(){return latestDiagnostics;},get room(){return room;},get self(){return self;},get module(){return module;},sample:()=>graphics.sample(),get booting(){return booting;}};
async function start() {
  config=await request('/api/config');
  if(config.engine==='c')$('intro').textContent='SM64 Coop Deluxe. Create a world or join friends; your progress stays saved.';
  if(config.engine==='rust')$('intro').textContent='Rust engine preview: castle grounds, movement, and co-op. The full game port is in progress.';
  if(insideDiscord) {
    if(!config.discordConfigured)throw new Error('This server still needs its SM64 Discord application settings.');
    sdk=new DiscordSDK(config.clientId);await sdk.ready();mobile=sdk.platform==='mobile'||mobile;
    $('browser-choices').hidden=true;$('name').parentElement.hidden=true;$('intro').textContent=config.engine==='rust'?'Rust engine preview. Your voice channel is your lobby; the full game port is in progress.':'Your voice channel is your lobby. Stars stay with your server.';
    $('lobby-form').hidden=false;status('Enter your voice channel’s world.');
  }else {
    if(!config.browserConfigured)throw new Error('Browser access needs a private server password. See the project README to configure it.');
    const session=await request('/api/browser/session');$('login-form').hidden=session.authenticated;$('lobby-form').hidden=!session.authenticated;
    status(session.authenticated?'Choose your name and enter a world.':'Sign in to the private game server.');
  }
}


function romStatus(text){$('rom-status').textContent=text;$('rom-forget').hidden=!localROM;}
$('rom-file').onchange=async()=>{
  const file=$('rom-file').files[0];if(!file)return;
  if(!$('rom-lawful').checked){romStatus('Confirm that you lawfully obtained this ROM.');$('rom-file').value='';return;}
  try{
    if(file.size!==ROM_BYTES)throw new Error('Choose an unmodified USA .z64 ROM (8 MiB).');
    const bytes=await validateROM(await file.arrayBuffer());
    localROM=bytes;
    try{await saveROM(bytes);await navigator.storage?.persist?.();romStatus('ROM saved in this browser. It is never uploaded.');}
    catch{romStatus('ROM ready for this session. Browser storage is unavailable; you will need to choose it again next time.');}
  }catch(error){romStatus(error.message);}finally{$('rom-file').value='';}
};
$('rom-forget').onclick=async()=>{
  try{if(module||socket)await leaveLobby();await forgetROM();localROM=null;filesPromise=null;romStatus('Local ROM removed. Choose your own ROM to play.');}
  catch{romStatus('Could not remove the saved ROM. You can clear this site’s storage in browser settings.');}
};
try{localROM=await loadROM();romStatus(localROM?'Your ROM is saved in this browser.':'Choose your own lawfully obtained USA ROM to play.');}
catch{romStatus('Browser storage is unavailable or invalid. Choose your ROM to play this session.');}

void start().catch(error=>status(error.message,true));
