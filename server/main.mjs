import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBrowserAuth } from './browser-auth.mjs';
import { AccessError, discordService } from './discord.mjs';
import { WorldStore, cleanName } from './world-store.mjs';
import { createRelay } from './relay.mjs';

export function loadConfig(env=process.env) {
  const list=value=>new Set((value||'').split(',').map(item=>item.trim()).filter(Boolean));
  return {host:env.HOST||'127.0.0.1',port:Number(env.PORT||8790),clientId:env.DISCORD_CLIENT_ID||'',secret:env.DISCORD_CLIENT_SECRET||'',
    botToken:env.DISCORD_BOT_TOKEN||'',guilds:list(env.ALLOWED_GUILD_IDS),channels:list(env.ALLOWED_CHANNEL_IDS),
    browserOrigin:env.BROWSER_ORIGIN||'',publicOrigin:env.PUBLIC_ORIGIN||'',browserPasswordHash:env.BROWSER_PASSWORD_HASH||'',
    browserSessionSecret:env.BROWSER_SESSION_SECRET||'',browserSecureCookies:!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.BROWSER_ORIGIN||''),worldDatabase:env.WORLD_DATABASE||resolve('data/worlds.sqlite'),
    engineKind:'c',engineRoot:resolve(env.ENGINE_ROOT||'private/engine'),maxPlayers:16};
}
export function createActivityServer(config,{discord=discordService(config),root=resolve('dist'),store=new WorldStore(config.worldDatabase)}={}) {
  root=resolve(root);
  const privateRoot=resolve(config.engineRoot);
  for(const path of [privateRoot,resolve(config.worldDatabase)])
    if(path===root||path.startsWith(root+sep))throw new Error('Game assets and world saves must be outside dist');
  const auth=createBrowserAuth({passwordHash:config.browserPasswordHash,sessionSecret:config.browserSessionSecret,secureCookies:config.browserSecureCookies!==false});
  const tickets=new Map(),dataSessions=new Map();let authorizing=0;
  const localOrigin=origin=>!config.browserOrigin&&(origin===`http://127.0.0.1:${server.address()?.port}`||origin===`http://localhost:${server.address()?.port}`);
  const browserOriginAllowed=origin=>auth.enabled&&Boolean(origin)&&(origin===config.browserOrigin||localOrigin(origin));
  const discordOriginAllowed=origin=>Boolean(config.clientId&&origin===`https://${config.clientId}.discordsays.com`);
  const allowedOrigin=origin=>browserOriginAllowed(origin)||discordOriginAllowed(origin);
  const verify=session=>session.authKind==='browser'?auth.verifySession(session):discord.instance(session.instanceId,session.userId).then(instance=>{
    if(instance.location.guild_id!==session.guildId||instance.location.channel_id!==session.channelId)throw new AccessError('Activity location changed');
  });
  const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
  async function body(req) {
    let size=0;const chunks=[];
    for await(const chunk of req) {size+=chunk.length;if(size>4096)throw new AccessError('Request too large',413);chunks.push(chunk);}
    try {const value=JSON.parse(Buffer.concat(chunks));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}
    catch {throw new AccessError('Invalid JSON request',400);}
  }
  function issue(session,lobby) {
    if(tickets.size>=256||dataSessions.size>=512)throw new AccessError('Server is busy; retry shortly',429);
    const identity={...session,lobbyId:lobby.id};
    const ticket=randomBytes(32).toString('base64url'),dataToken=randomBytes(32).toString('base64url');
    tickets.set(ticket,{...identity,expires:Date.now()+30000});
    dataSessions.set(dataToken,{...identity,expires:Date.now()+60*60*1000,downloads:0});
    return {ticket,dataToken,lobby:{code:lobby.code,name:lobby.name},world:store.snapshot(lobby.world)};
  }
  async function serveFile(req,res,file,base) {
    const canonical=await realpath(file).catch(()=>null),canonicalBase=await realpath(base).catch(()=>null);
    if(!canonical||!canonicalBase||!canonical.startsWith(canonicalBase+sep))throw new AccessError('Not found',404);
    let served=canonical,encoding;
    const accepted=(req.headers['accept-encoding']||'').split(',').map(item=>{const [name,...parameters]=item.trim().split(';');return{name,q:Number(parameters.find(item=>item.trim().startsWith('q='))?.trim().slice(2)??1)};});
    for(const [name,suffix]of [['br','.br'],['gzip','.gz']]) {
      if(!accepted.some(item=>item.name===name&&item.q>0))continue;
      const compressed=await realpath(canonical+suffix).catch(()=>null);
      if(compressed?.startsWith(canonicalBase+sep)&&(await stat(compressed)).isFile()){served=compressed;encoding=name;break;}
    }
    const info=await stat(served);
    if(!info.isFile())throw new AccessError('Not found',404);
    const types={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',wasm:'application/wasm',json:'application/json',svg:'image/svg+xml',webmanifest:'application/manifest+json'};
    res.writeHead(200,{'content-type':types[canonical.split('.').pop()]||'application/octet-stream','content-length':info.size,'cache-control':'no-store','vary':'Accept-Encoding',...(encoding?{'content-encoding':encoding}:{})});
    if(req.method==='HEAD')res.end();else createReadStream(served).on('error',()=>res.destroy()).pipe(res);
  }
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'self' https://discord.com https://*.discord.com https://*.discordsays.com");
    try {
      const path=new URL(req.url,'http://local').pathname;
      if(req.method==='GET'&&path==='/health')return json(res,200,{ok:true,engine:config.engineKind==='rust'?'sm64-rust-preview':'sm64coopdx-v1.5.1-web',activeLobbies:relay.rooms.size});
      if(req.method==='GET'&&path==='/api/config')return json(res,200,{clientId:config.clientId,browserConfigured:auth.enabled,browserOrigin:config.browserOrigin,
        discordConfigured:Boolean(config.clientId&&config.secret&&config.botToken&&config.guilds.size),engine:config.engineKind||'rust',maxPlayers:config.maxPlayers,targetFps:60});
      if(path.startsWith('/api/browser/')) {
        if(!auth.enabled)throw new AccessError('Browser sign-in is not configured',503);
        if(req.method==='GET'&&path==='/api/browser/session')return json(res,200,{authenticated:Boolean(auth.authenticate(req.headers.cookie))});
        if(req.method!=='POST')throw new AccessError('Method not allowed',405);
        if(!browserOriginAllowed(req.headers.origin))throw new AccessError('Origin denied');
        if(path==='/api/browser/login') {
          const value=await body(req),result=await auth.login(value.password,value.name,req.socket.remoteAddress||'unknown');
          res.setHeader('Set-Cookie',auth.cookie(result.token));return json(res,200,{authenticated:true});
        }
        const session=auth.authenticate(req.headers.cookie);
        if(!session)throw new AccessError('Sign in to continue',401);
        if(path==='/api/browser/logout') {
          auth.logout(req.headers.cookie);
          for(const peer of relay.wss.clients)if(peer.session?.sessionId===session.sessionId)peer.close(1008,'Signed out');
          for(const [key,value]of tickets)if(value.sessionId===session.sessionId)tickets.delete(key);
          for(const [key,value]of dataSessions)if(value.sessionId===session.sessionId)dataSessions.delete(key);
          res.setHeader('Set-Cookie',auth.clearCookie());return json(res,200,{authenticated:false});
        }
        const value=await body(req);
        if(path==='/api/browser/lobby') {
          const lobby=value.create===true?store.browser(value.worldName):store.byCode(value.code);
          if(!lobby)throw new AccessError('That lobby code was not found',404);
          return json(res,200,issue({...session,name:cleanName(value.name,session.name)},lobby));
        }
        throw new AccessError('Not found',404);
      }
      if(req.method==='POST'&&path==='/api/session') {
        if(!discordOriginAllowed(req.headers.origin))throw new AccessError('Origin denied');
        if(authorizing>=8)throw new AccessError('Authorization is busy; retry shortly',429);
        const value=await body(req);
        if(typeof value.code!=='string'||!value.code||value.code.length>2048||typeof value.instanceId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(value.instanceId))throw new AccessError('Invalid Activity session',400);
        authorizing++;
        try {
          const {accessToken,user,instance}=await discord.authorize(value.code,value.instanceId);
          const location=instance.location,lobby=store.discord(location.guild_id,location.channel_id);
          return json(res,200,{accessToken,...issue({authKind:'discord',userId:user.id,name:cleanName(user.global_name||user.username),instanceId:value.instanceId,
            guildId:location.guild_id,channelId:location.channel_id},lobby)});
        }finally{authorizing--;}
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw new AccessError('Method not allowed',405);
      if(path.startsWith('/api/engine/')) {
        const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'')?.[1],session=token&&dataSessions.get(token);
        if(!session||session.expires<Date.now())throw new AccessError('Join a lobby to load the game',401);
        await verify(session);
        if(session.downloads>=3)throw new AccessError('Too many downloads',429);
        const name=path.slice('/api/engine/'.length);
        const permitted=['sm64.wasm','shell.data'].includes(name);
        if(!permitted)throw new AccessError('Not found',404);
        session.downloads++;let released=false;
        const release=()=>{if(!released){released=true;session.downloads--;}};
        res.once('close',release);res.once('finish',release);
        await serveFile(req,res,resolve(privateRoot,name),privateRoot);return;
      }
      const decoded=decodeURIComponent(path),file=resolve(root,'.'+(decoded==='/'?'/index.html':decoded));
      if(!file.startsWith(root+sep))throw new AccessError('Not found',404);
      await serveFile(req,res,file,root);
    }catch(error){if(!res.headersSent)json(res,error.status||500,{error:error.status?error.message:'The activity server encountered an error'});else res.destroy();}
  });
  server.requestTimeout=15000;
  const relay=createRelay(server,{allowedOrigin,store,maxPlayers:config.maxPlayers,verify,consumeTicket:ticket=>{
    const session=tickets.get(ticket);tickets.delete(ticket);
    if(!session||session.expires<Date.now())return null;
    if(session.authKind==='browser'){try{auth.verifySession(session);}catch{return null;}}
    return session;
  }});
  const cleanup=setInterval(()=>{
    for(const [key,value]of tickets)if(value.expires<Date.now())tickets.delete(key);
    for(const [key,value]of dataSessions)if(value.expires<Date.now())dataSessions.delete(key);
  },30000);cleanup.unref();
  server.on('close',()=>{clearInterval(cleanup);relay.close();store.close();});
  return {server,relay,store,auth};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const config=loadConfig(),{server,relay}=createActivityServer(config);
  server.listen(config.port,config.host,()=>console.log(`SM64 Coop activity: http://${config.host}:${config.port}`));
  let stopping=false;
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(stopping)return;stopping=true;relay.close();server.close();});
}
