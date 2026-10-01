// Pointer roles stay fixed until release, even when thumbs cross the midpoint.
export function createGestures({emit,look,move,airborne,now=()=>performance.now()}) {
  const fingers=new Map();
  function down(id,x,y,role,width) {
    role ||= x<width/2?'move':'look';
    if([...fingers.values()].some(f=>f.role===role))return false;
    fingers.set(id,{role,x,y,lastX:x,start:now(),mode:'pending'});
    if(role==='move')move(0,0,x,y);
    if(role==='crouch'||role==='center')emit(role,true,id);
    return true;
  }
  function drag(id,x,y) {
    const f=fingers.get(id);if(!f)return;
    const dx=x-f.x,dy=y-f.y;
    if(f.role==='move'){
      const length=Math.max(58,Math.hypot(dx,dy));move(dx/length,-dy/length,f.x,f.y);
    }else if(f.role==='crouch'){
      if(f.mode==='pending'&&dy<-30&&-dy>Math.abs(dx)*1.2){f.mode='action';emit('longJump');}
    }else if(f.role==='look'){
      if(f.mode==='pending'){
        if(Math.abs(dx)>10&&Math.abs(dx)>Math.abs(dy)*1.2)f.mode='look';
        else if(Math.abs(dy)>30&&Math.abs(dy)>Math.abs(dx)*1.2){
          f.mode='action';if(dy<0)emit('jump');else if(airborne())emit('groundPound');
        }
      }
      if(f.mode==='look')look(x-f.lastX);
    }
    f.lastX=x;
  }
  function up(id,x,y,cancel=false) {
    const f=fingers.get(id);if(!f)return;
    if(!cancel)drag(id,x,y);
    if(f.role==='move')move(0,0);
    if(f.role==='crouch'||f.role==='center')emit(f.role,false,id);
    if(!cancel&&f.role==='look'&&f.mode==='pending'&&Math.hypot(x-f.x,y-f.y)<12&&now()-f.start<300)emit('attack');
    fingers.delete(id);
  }
  function reset(){for(const [id,f]of fingers)up(id,f.x,f.y,true);}
  return {down,drag,up,reset};
}
