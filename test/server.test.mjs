import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createActivityServer, loadConfig } from '../server/main.mjs';
import { hashPassword } from '../server/browser-auth.mjs';
import { signSlot } from '../shared/save.mjs';
import { verifyInstance } from '../server/discord.mjs';
import { gzipSync } from 'node:zlib';

async function fixture(t,engineKind='c') {
  const dir=await mkdtemp(join(tmpdir(),'sm64-server-test-')),root=join(dir,'dist'),engineRoot=join(dir,'engine');
  await mkdir(root);await mkdir(engineRoot);await writeFile(join(root,'index.html'),'fixture');await writeFile(join(engineRoot,'shell.data'),'shell resources');
  const config={...loadConfig({}),port:0,clientId:'12345',secret:'fixture',botToken:'fixture',guilds:new Set(['100','101']),channels:new Set(),
    engineKind,engineRoot,worldDatabase:join(dir,'worlds.sqlite'),browserPasswordHash:await hashPassword('fixture-password'),browserSessionSecret:'fixture-secret-'.repeat(4),browserSecureCookies:false};
  const instances=new Map();
  const discord={async authorize(code,id){const instance=instances.get(id);verifyInstance(instance,code,id,config);return{accessToken:'fixture',user:{id:code,username:code},instance};},
    async instance(id,user){const instance=instances.get(id);verifyInstance(instance,user,id,config);return instance;}};
  const app=createActivityServer(config,{root,discord});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{app.relay.close();await new Promise(resolve=>app.server.close(resolve));await rm(dir,{recursive:true,force:true});});
  async function post(path,value,{cookie,discordOrigin=false}={}) {
    const response=await fetch(origin+path,{method:'POST',headers:{origin:discordOrigin?'https://12345.discordsays.com':origin,'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(value)});
    return {response,value:await response.json()};
  }
  async function browser(name='Browser') {const result=await post('/api/browser/login',{password:'fixture-password',name});assert.equal(result.response.status,200);return result.response.headers.get('set-cookie').split(';')[0];}
  async function activity(user,instanceId,guild='100',channel='200') {
    instances.set(instanceId,{application_id:'12345',instance_id:instanceId,users:[user],location:{kind:'gc',guild_id:guild,channel_id:channel}});
    const result=await post('/api/session',{code:user,instanceId},{discordOrigin:true});assert.equal(result.response.status,200);return result.value;
  }
  function connect(ticket,webOrigin=origin) {
    const peer=new WebSocket(origin.replace('http:','ws:')+'/relay',{origin:webOrigin});
    const messages=[];peer.on('error',()=>{});peer.on('message',(bytes,binary)=>{messages.push(binary?Buffer.from(bytes):JSON.parse(bytes));});
    peer.on('open',()=>peer.send(JSON.stringify({type:'join',ticket})));
    return {peer,messages};
  }
  async function until(predicate) {const deadline=Date.now()+4000;while(!predicate()){if(Date.now()>deadline)throw new Error('Timed out waiting for relay');await new Promise(resolve=>setTimeout(resolve,10));}return predicate();}
  return {...app,root,engineRoot,origin,post,browser,activity,connect,until};
}
test('Discord sessions in the same VC share a lobby across different instance IDs',async t=>{
  const f=await fixture(t),a=await f.activity('A','one'),b=await f.activity('B','two'),c=await f.activity('C','three','100','201');
  assert.equal(a.lobby.code,b.lobby.code);assert.notEqual(a.lobby.code,c.lobby.code);
  const pa=f.connect(a.ticket,'https://12345.discordsays.com'),pb=f.connect(b.ticket,'https://12345.discordsays.com');
  const wa=await f.until(()=>pa.messages.find(x=>x.type==='welcome')),wb=await f.until(()=>pb.messages.find(x=>x.type==='welcome'));
  assert.equal(wa.host,wa.self);assert.equal(wb.host,wa.self);assert.equal(wb.players.length,2);
});
test('web players create a world and join a Discord VC lobby by its durable code',async t=>{
  const f=await fixture(t),activity=await f.activity('A','one'),cookie=await f.browser();
  const joined=await f.post('/api/browser/lobby',{code:activity.lobby.code,name:'Web friend'},{cookie});assert.equal(joined.response.status,200);
  assert.equal(joined.value.lobby.code,activity.lobby.code);
  const created=await f.post('/api/browser/lobby',{create:true,worldName:'Friends',name:'Web friend'},{cookie});assert.equal(created.response.status,200);
  assert.notEqual(created.value.lobby.code,activity.lobby.code);assert.equal(created.value.lobby.name,'Friends');
});
test('join tickets cannot be replayed and native packet source IDs cannot be spoofed',async t=>{
  const f=await fixture(t),a=await f.activity('A','one'),b=await f.activity('B','two');
  const pa=f.connect(a.ticket,'https://12345.discordsays.com'),pb=f.connect(b.ticket,'https://12345.discordsays.com');
  const wa=await f.until(()=>pa.messages.find(x=>x.type==='welcome')),wb=await f.until(()=>pb.messages.find(x=>x.type==='welcome'));
  const replay=f.connect(a.ticket,'https://12345.discordsays.com');await f.until(()=>replay.peer.readyState===WebSocket.CLOSED);assert.equal(replay.messages.length,0);
  const frame=Buffer.alloc(11);frame.writeUInt32LE(0xdeadbeef,0);frame.writeUInt32LE(wb.self,4);frame.set([1,2,3],8);pa.peer.send(frame);
  const received=await f.until(()=>pb.messages.find(Buffer.isBuffer));assert.equal(received.readUInt32LE(0),wa.self);assert.deepEqual([...received.subarray(8)],[1,2,3]);
});
test('only the elected host can save; its checkpoint survives host departure',async t=>{
  const f=await fixture(t),a=await f.activity('A','one'),b=await f.activity('B','two');
  const pa=f.connect(a.ticket,'https://12345.discordsays.com'),pb=f.connect(b.ticket,'https://12345.discordsays.com');
  const wa=await f.until(()=>pa.messages.find(x=>x.type==='welcome'));await f.until(()=>pb.messages.find(x=>x.type==='welcome'));
  const bytes=Buffer.alloc(512);bytes.writeUInt32BE(1,8);bytes[12]=1;signSlot(bytes.subarray(0,56));bytes.copy(bytes,56,0,56);
  pa.peer.send(JSON.stringify({type:'save',save:bytes.toString('base64')}));await f.until(()=>pb.messages.find(x=>x.type==='saved'));
  pa.peer.close();const changed=await f.until(()=>pb.messages.find(x=>x.type==='room'&&x.host!==wa.self));assert.equal(changed.world.stars,1);assert.equal(changed.generation,2);
  const c=await f.activity('C','three'),pc=f.connect(c.ticket,'https://12345.discordsays.com');await f.until(()=>pc.messages.find(x=>x.type==='welcome'));
  pc.peer.send(JSON.stringify({type:'save',save:bytes.toString('base64')}));await f.until(()=>pc.peer.readyState===WebSocket.CLOSED);
  assert.equal(f.store.snapshot(f.store.byCode(a.lobby.code).world).stars,1);
});
test('a host entering the background hands the lobby to a ready foreground player',async t=>{
  const f=await fixture(t),a=await f.activity('A','one'),b=await f.activity('B','two');
  const pa=f.connect(a.ticket,'https://12345.discordsays.com'),pb=f.connect(b.ticket,'https://12345.discordsays.com');
  const wa=await f.until(()=>pa.messages.find(x=>x.type==='welcome')),wb=await f.until(()=>pb.messages.find(x=>x.type==='welcome'));
  pa.peer.send(JSON.stringify({type:'ready',background:false}));pb.peer.send(JSON.stringify({type:'ready',background:false}));
  pa.peer.send(JSON.stringify({type:'presence',background:true}));
  const changed=await f.until(()=>pb.messages.find(x=>x.type==='room'&&x.generation>wa.generation));
  assert.equal(changed.host,wb.self);assert.equal(changed.players.length,2);assert.equal(pa.peer.readyState,WebSocket.OPEN);
});
test('assets require authorization; logout revokes tickets, assets and live connections',async t=>{
  const f=await fixture(t);assert.equal((await fetch(f.origin+'/api/engine/shell.data')).status,401);
  const cookie=await f.browser(),joined=await f.post('/api/browser/lobby',{create:true,name:'Browser'},{cookie});
  const headers={authorization:`Bearer ${joined.value.dataToken}`};assert.equal((await fetch(f.origin+'/api/engine/shell.data',{headers})).status,200);
  const live=f.connect(joined.value.ticket);await f.until(()=>live.messages.find(x=>x.type==='welcome'));
  const pending=await f.post('/api/browser/lobby',{code:joined.value.lobby.code,name:'Browser'},{cookie});
  assert.equal((await f.post('/api/browser/logout',{}, {cookie})).response.status,200);await f.until(()=>live.peer.readyState===WebSocket.CLOSED);
  assert.equal((await fetch(f.origin+'/api/engine/shell.data',{headers})).status,401);
  const denied=f.connect(pending.value.ticket);await f.until(()=>denied.peer.readyState===WebSocket.CLOSED);
});
test('cross-origin sign-in and static symlinks cannot expose shell resources',async t=>{
  const f=await fixture(t);
  const bad=await fetch(f.origin+'/api/browser/login',{method:'POST',headers:{origin:'https://outside.example','content-type':'application/json'},body:JSON.stringify({password:'fixture-password'})});assert.equal(bad.status,403);
  await symlink(join(f.engineRoot,'shell.data'),join(f.root,'leak.data'));assert.equal((await fetch(f.origin+'/leak.data')).status,404);
});
test('compressed game downloads retain authorization and original MIME; the raw ROM is unavailable',async t=>{
  const f=await fixture(t);await writeFile(join(f.engineRoot,'shell.data.gz'),gzipSync('shell resources'));
  const cookie=await f.browser(),joined=await f.post('/api/browser/lobby',{create:true,name:'Browser'},{cookie});
  const headers={authorization:`Bearer ${joined.value.dataToken}`,'accept-encoding':'gzip'};
  const response=await fetch(f.origin+'/api/engine/shell.data',{headers});
  assert.equal(response.headers.get('content-encoding'),'gzip');assert.equal(await response.text(),'shell resources');
  assert.equal((await fetch(f.origin+'/api/engine/shell.data',{headers:{...headers,'accept-encoding':'gzip;q=0'}})).headers.get('content-encoding'),null);
  await writeFile(join(f.engineRoot,'baserom.us.z64'),'fixture rom');
  assert.equal((await fetch(f.origin+'/api/engine/baserom.us.z64',{headers})).status,404);
});
test('local HTTP cookies are allowed only for a configured loopback origin',()=>{
  assert.equal(loadConfig({BROWSER_ORIGIN:'http://127.0.0.1:8790'}).browserSecureCookies,false);
  assert.equal(loadConfig({BROWSER_ORIGIN:'http://other.example:8790'}).browserSecureCookies,true);
  assert.equal(loadConfig({BROWSER_ORIGIN:'https://sm64.example.com'}).browserSecureCookies,true);
});

test('ROMs and streamed asset packs are unavailable even to joined players',async t=>{
  const f=await fixture(t);const b=await f.browser();
  const joined=await f.post('/api/browser/lobby',{create:true,worldName:'Local ROM',name:'Player'},{cookie:b});
  const headers={authorization:`Bearer ${joined.value.dataToken}`};
  for(const name of ['sm64.data','baserom.us.z64','assets.bin','manifest.json','chunks/'+'a'.repeat(64)+'.bin']) {
    assert.equal((await fetch(f.origin+'/api/engine/'+name,{headers})).status,404);
  }
});
