import {createGestures} from './gestures.mjs';
export const BUTTON={jump:0x8000,attack:0x4000,crouch:0x2000,center:0x20};
export function stick(value,deadzone=0.16) {
  if(!Number.isFinite(value)||Math.abs(value)<=deadzone)return 0;
  return Math.sign(value)*Math.min(1,(Math.abs(value)-deadzone)/(1-deadzone));
}
export function circle(x,y) {const length=Math.hypot(x,y);return length>1?[x/length,y/length]:[x,y];}
export function createInput({canvas,enabled,active=enabled,onMenu,ui=()=>0,pointer=()=>{},action=()=>{},airborne=()=>false,sensitivity=()=>1,invert=()=>false,touch=false}) {
  const keys=new Set(),gestures=new Map(),held=new Map(),latched=new Map();
  let move=[0,0],mouse=[0,0],gamepadMenu=false,touchGestures;
  const menuPointers=new Set();
  function menuPointer(event,down){const r=canvas.getBoundingClientRect();pointer((event.clientX-r.left)/r.width,(event.clientY-r.top)/r.height,down);}
  const keyButtons={Space:'jump',KeyE:'attack',KeyX:'attack',ShiftLeft:'crouch',ShiftRight:'crouch',KeyC:'center'};
  const gameKeys=new Set(['KeyW','KeyA','KeyS','KeyD','ArrowLeft','ArrowRight','ArrowUp','ArrowDown',...Object.keys(keyButtons)]);
  function button(action,down,id) {
    const owners=held.get(action)||new Set();
    if(down){owners.add(id);latched.set(action,performance.now()+65);}else owners.delete(id);
    held.set(action,owners);
  }
  function reset() {touchGestures?.reset();menuPointers.clear();pointer(-1,-1,-1);action(0);keys.clear();gestures.clear();held.clear();latched.clear();move=[0,0];mouse=[0,0];document.getElementById('move-stick')?.setAttribute('hidden','');}
  window.addEventListener('keydown',event=>{
    if(event.code==='Escape'&&enabled()){event.preventDefault();event.stopImmediatePropagation();onMenu();return;}
    if(!enabled()){if(active()&&(gameKeys.has(event.code)||event.code==='Escape'))event.stopImmediatePropagation();return;}
    if(!gameKeys.has(event.code))return;
    event.preventDefault();event.stopImmediatePropagation();keys.add(event.code);
    if(keyButtons[event.code])button(keyButtons[event.code],true,event.code);
  },true);
  window.addEventListener('keyup',event=>{
    if(active()&&gameKeys.has(event.code))event.stopImmediatePropagation();
    keys.delete(event.code);if(keyButtons[event.code])button(keyButtons[event.code],false,event.code);
  },true);
  window.addEventListener('blur',reset);window.addEventListener('resize',reset);document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();});
  canvas.addEventListener('contextmenu',event=>event.preventDefault());
  function mouseDown(event){
    if(event.pointerType!=='mouse'||!enabled())return;
    if(ui()){event.preventDefault();menuPointers.add(event.pointerId);menuPointer(event,1);return;}
    if(document.pointerLockElement!==canvas){try{void Promise.resolve(canvas.requestPointerLock?.()).catch(()=>{});}catch{}}
    else if(event.button===0)button('attack',true,'mouse');
  }
  canvas.addEventListener('pointerdown',mouseDown);
  window.addEventListener('pointerup',event=>{if(event.pointerType==='mouse'){button('attack',false,'mouse');if(menuPointers.delete(event.pointerId))menuPointer(event,0);}});
  canvas.addEventListener('pointermove',event=>{if(event.pointerType==='mouse'&&enabled()&&ui())menuPointer(event,2);});
  canvas.addEventListener('pointerleave',()=>{if(ui()&&!menuPointers.size)pointer(-1,-1,2);});
  window.addEventListener('mousemove',event=>{
    if(enabled()&&!ui()&&document.pointerLockElement===canvas){mouse[0]+=event.movementX;mouse[1]+=event.movementY;}
  });
  if(touch) {
    const surface=document.getElementById('touch-controls'),stickElement=document.getElementById('move-stick');surface.hidden=false;
    touchGestures=createGestures({airborne,
      emit(name,down,id){if(down!==undefined)button(name,down,id);else action({jump:1,attack:2,groundPound:3,longJump:4}[name]);},
      look(dx){mouse[0]+=dx*2.9;},
      move(x,y,ox,oy){move=[x,y];stickElement.hidden=ox===undefined;if(ox!==undefined){stickElement.style.left=`${ox}px`;stickElement.style.top=`${oy}px`;document.getElementById('stick-knob').style.transform=`translate(${x*58}px,${-y*58}px)`;}}
    });
    surface.addEventListener('pointerdown',event=>{
      if(event.pointerType==='mouse'){mouseDown(event);return;}if(!enabled())return;event.preventDefault();
      if(ui()){menuPointers.add(event.pointerId);surface.setPointerCapture(event.pointerId);menuPointer(event,1);return;}
      const role=event.target.closest('button[data-role]')?.dataset.role;
      if(touchGestures.down(event.pointerId,event.clientX,event.clientY,role,innerWidth))surface.setPointerCapture(event.pointerId);
    });
    surface.addEventListener('pointermove',event=>{if(event.pointerType==='mouse'){if(enabled()&&ui())menuPointer(event,2);return;}event.preventDefault();if(menuPointers.has(event.pointerId))menuPointer(event,2);else touchGestures.drag(event.pointerId,event.clientX,event.clientY);});
    function release(event){const cancel=event.type!=='pointerup';if(menuPointers.delete(event.pointerId))menuPointer(event,cancel?-1:0);else touchGestures.up(event.pointerId,event.clientX,event.clientY,cancel);}
    for(const name of ['pointerup','pointercancel','lostpointercapture'])surface.addEventListener(name,release);
  }
  function read() {
    const pad=Array.from(navigator.getGamepads?.()||[]).find(p=>p?.connected&&p.mapping==='standard');
    const menu=Boolean(pad?.buttons[9]?.pressed);
    if(menu&&!gamepadMenu)onMenu();gamepadMenu=menu;
    if(!enabled())return [0,0,0,0,0,0,0];
    let [x,y]=move;
    x+=(keys.has('KeyD')?1:0)-(keys.has('KeyA')?1:0);y+=(keys.has('KeyW')?1:0)-(keys.has('KeyS')?1:0);
    if(pad){x+=stick(pad.axes[0]);y-=stick(pad.axes[1]);}
    [x,y]=circle(x,y);
    let buttons=0;
    for(const [action,mask]of Object.entries(BUTTON))if(held.get(action)?.size||(latched.get(action)||0)>performance.now())buttons|=mask;
    if(pad){if(pad.buttons[0]?.pressed)buttons|=BUTTON.jump;if(pad.buttons[1]?.pressed||pad.buttons[2]?.pressed)buttons|=BUTTON.attack;
      if(pad.buttons[6]?.pressed||pad.buttons[7]?.pressed)buttons|=BUTTON.crouch;if(pad.buttons[4]?.pressed)buttons|=BUTTON.center;}
    const cx=(pad?stick(pad.axes[2]):0)+(keys.has('ArrowRight')?1:0)-(keys.has('ArrowLeft')?1:0);
    const cy=(pad?-stick(pad.axes[3]):0)+(keys.has('ArrowUp')?1:0)-(keys.has('ArrowDown')?1:0);
    const [mx,my]=mouse;mouse=[0,0];
    return [buttons,Math.round(x*80),Math.round(y*80),Math.round(Math.max(-1,Math.min(1,cx*sensitivity()))*80),Math.round(Math.max(-1,Math.min(1,cy*sensitivity()))*80*(invert()?-1:1)),Math.round(mx*sensitivity()),Math.round(my*sensitivity()*(invert()?-1:1))];
  }
  return {read,reset};
}
