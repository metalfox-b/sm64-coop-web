export function displaySize(width,height,renderHeight) {
  const ratio=Math.min(2.5,Math.max(0.45,width/Math.max(1,height)));
  const h=Math.max(240,Math.round(Math.min(height,renderHeight)));
  return {width:Math.round(h*ratio),height:h};
}
export function createGraphics({mobile,onChange,inactive=()=>false,quality=()=> 'auto'}) {
  let renderHeight=mobile?480:600,last=0,start=0,frames=0,slow=0,fast=0,fps=0;
  const history=[];
  function presented(now=performance.now()) {
    if(inactive()){last=start=0;frames=0;return;}
    if(last&&now-last<250)history.push(now-last);
    if(history.length>600)history.shift();last=now;
    if(!start)start=now;frames++;
    if(now-start<2000)return;
    fps=(frames-1)*1000/(now-start);start=now;frames=1;
    if(quality()!=='auto')return;
    slow=fps<53?slow+1:0;fast=fps>58?fast+1:0;
    if(slow>=2&&renderHeight>360){renderHeight=renderHeight>480?480:360;slow=fast=0;onChange();}
    if(fast>=12&&renderHeight<(mobile?480:600)){renderHeight=renderHeight<480?480:600;slow=fast=0;onChange();}
  }
  return {presented,get height(){return {'performance':360,'balanced':480,'high':720}[quality()]||renderHeight;},
    sample(){const sorted=[...history].sort((a,b)=>a-b);return {fps,renderHeight:this.height,samples:history.length,p95Ms:sorted[Math.floor(sorted.length*0.95)]||0};}};
}
