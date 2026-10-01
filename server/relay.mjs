import { WebSocketServer, WebSocket } from 'ws';
import { decodeSave } from '../shared/save.mjs';

const OPEN = WebSocket.OPEN;
export function createRelay(server, {allowedOrigin, consumeTicket, verify, store, maxPlayers=16}) {
  const rooms = new Map();
  const wss = new WebSocketServer({noServer:true, maxPayload:4096, perMessageDeflate:false});
  let nextId = 1, closed = false;
  const send = (peer, message) => {
    if (peer.readyState !== OPEN) return;
    if (peer.bufferedAmount > 256 * 1024) { peer.close(1013, 'Connection is too slow; reconnect'); return; }
    peer.send(JSON.stringify(message));
  };
  const describe = room => ({type:'room', id:room.id, host:room.host, generation:room.generation,
    code:room.lobby.code, name:room.lobby.name, maxPlayers, players:[...room.peers.values()].map(peer=>({id:peer.id,name:peer.session.name})),
    world:store.snapshot(room.lobby.world)});
  const publish = room => { const message = describe(room); for (const peer of room.peers.values()) send(peer,message); };
  function handoffBackgroundHost(room) {
    if(!room.peers.get(room.host)?.background)return;
    const replacement=[...room.peers.values()].find(peer=>peer.id!==room.host&&peer.ready&&!peer.background);
    if(!replacement)return;
    room.host=replacement.id;room.generation++;
    for(const peer of room.peers.values())peer.ready=false;
    publish(room);
  }
  function remove(peer) {
    const room = peer.room;
    if (!room || room.peers.get(peer.id) !== peer) return;
    room.peers.delete(peer.id); peer.room = null;
    if (!room.peers.size) { rooms.delete(room.id); return; }
    if (room.host === peer.id) { room.host = room.peers.keys().next().value; room.generation++; }
    publish(room);
  }
  server.on('upgrade', (req,socket,head)=>{
    const path = new URL(req.url,'http://local').pathname;
    if (path !== '/relay' || !allowedOrigin(req.headers.origin) || wss.clients.size >= 256) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req,socket,head,peer=>wss.emit('connection',peer,req));
  });
  wss.on('connection', peer=>{
    peer.alive=true; peer.windowStart=Date.now(); peer.packets=0; peer.bytes=0; peer.lastSave=0;
    const timer=setTimeout(()=>peer.close(1008,'Join ticket required'),10000); timer.unref();
    peer.on('pong',()=>{peer.alive=true;});
    peer.on('error',()=>{});
    peer.on('close',()=>{clearTimeout(timer);remove(peer);});
    peer.on('message',(data,binary)=>{
      try {
        const now=Date.now();
        if (now-peer.windowStart>=1000) {peer.windowStart=now;peer.packets=0;peer.bytes=0;}
        const fanout=peer.room?.host===peer.id?maxPlayers:1;
        if (++peer.packets>480*fanout || (peer.bytes+=data.length)>512*1024*fanout) throw new Error('Packet rate exceeded');
        if (!peer.room) {
          if (binary) throw new Error('Join ticket required');
          const value=JSON.parse(data.toString());
          if (value.type!=='join' || typeof value.ticket!=='string') throw new Error('Join ticket required');
          const session=consumeTicket(value.ticket);
          if (!session) throw new Error('Join ticket expired');
          const lobby=store.byId(session.lobbyId);
          if (!lobby) throw new Error('Lobby unavailable');
          let room=rooms.get(lobby.id);
          if (!room) {room={id:lobby.id,lobby,peers:new Map(),host:0,generation:1};rooms.set(lobby.id,room);}
          // One connection per authenticated user in this lobby. A replacement inherits its role.
          const old=[...room.peers.values()].find(item=>item.session.userId===session.userId);
          if (old) {peer.id=old.id;old.room=null;room.peers.delete(old.id);old.close(4001,'Connection replaced');if(room.host===old.id)room.generation++;}
          else {
            if (room.peers.size>=maxPlayers) throw new Error('Lobby is full');
            peer.id=nextId++; if (nextId>0xffffffff) nextId=1;
          }
          peer.session=session;peer.room=room;room.peers.set(peer.id,peer);
          if (!room.host) room.host=peer.id;
          clearTimeout(timer);send(peer,{...describe(room),type:'welcome',self:peer.id});publish(room);return;
        }
        if (binary) {
          if (data.length<=8 || data.length>=3008) throw new Error('Invalid native packet length');
          const destination=data.readUInt32LE(4), room=peer.room;
          const target=room.peers.get(destination);
          if (!target || target===peer) return;
          if (peer.id!==room.host && destination!==room.host) throw new Error('Clients must route through the host');
          if (target.readyState!==OPEN || target.bufferedAmount>256*1024) {target.close(1013,'Relay backpressure');return;}
          const frame=Buffer.from(data);frame.writeUInt32LE(peer.id,0);target.send(frame,{binary:true});return;
        }
        const message=JSON.parse(data.toString());
        if (message.type==='save') {
          if (peer.id!==peer.room.host) throw new Error('Only the current host can save');
          if (now-peer.lastSave<250) throw new Error('Save rate exceeded');
          peer.lastSave=now;
          const world=store.save(peer.room.lobby.world,decodeSave(message.save));
          for (const room of rooms.values()) if (room.lobby.world===peer.room.lobby.world)
            for (const player of room.peers.values()) send(player,{type:'saved',world});
        } else if (message.type==='ready') {peer.ready=true;peer.background=message.background===true;handoffBackgroundHost(peer.room);}
        else if(message.type==='presence'&&typeof message.background==='boolean'){peer.background=message.background;handoffBackgroundHost(peer.room);}
        else throw new Error('Unknown relay message');
      } catch(error) {peer.close(1008,error.message.slice(0,100));}
    });
  });
  const heartbeat=setInterval(async()=>{
    for (const peer of wss.clients) {
      if (!peer.alive) {peer.terminate();continue;}
      peer.alive=false;peer.ping();
      if (peer.session && !peer.checking) {
        peer.checking=true;
        Promise.resolve().then(()=>verify(peer.session)).catch(()=>peer.close(1008,'Session is no longer authorized')).finally(()=>{peer.checking=false;});
      }
    }
  },15000);heartbeat.unref();
  function close() {
    if(closed)return;closed=true;clearInterval(heartbeat);
    for(const peer of wss.clients){peer.room=null;peer.terminate();}
    rooms.clear();wss.close();
  }
  return {wss,rooms,close,snapshot:code=>{
    const lobby=store.byCode(code);if(!lobby)return null;
    const room=rooms.get(lobby.id);
    return {code:lobby.code,name:lobby.name,players:room?.peers.size||0,maxPlayers,world:store.snapshot(lobby.world)};
  }};
}
