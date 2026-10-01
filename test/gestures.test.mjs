import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGestures} from '../client/gestures.mjs';
function fixture(air=true){const events=[],looks=[],moves=[];let time=0;return {events,looks,moves,setTime:t=>time=t,g:createGestures({emit:(...v)=>events.push(v),look:v=>looks.push(v),move:(...v)=>moves.push(v),airborne:()=>air,now:()=>time})};}
test('left movement starts under the thumb and retains ownership across midpoint',()=>{
 const {g,moves,events,looks}=fixture();g.down(1,180,300,undefined,390);g.drag(1,260,300);g.up(1,260,300);
 assert.deepEqual(moves,[[0,0,180,300],[1,-0,180,300],[1,-0,180,300],[0,0]]);assert.equal(events.length+looks.length,0);
});
test('right vertical gestures fire once without moving the camera',()=>{
 for(const [dy,expected]of [[-60,'jump'],[60,'groundPound']]){const {g,events,looks}=fixture();g.down(1,300,400,undefined,390);g.drag(1,302,400+dy);g.drag(1,303,400+dy*2);g.up(1,303,400+dy*2);assert.deepEqual(events,[[expected]]);assert.deepEqual(looks,[]);}
});
test('ground swipe down does not crouch or ground-pound',()=>{
 const {g,events}=fixture(false);g.down(1,300,400,undefined,390);g.up(1,300,470);assert.deepEqual(events,[]);
});
test('horizontal look is axis locked and never attacks or jumps',()=>{
 const {g,looks,events}=fixture();g.down(1,300,400,undefined,390);g.drag(1,325,402);g.drag(1,350,300);g.up(1,350,300);assert.equal(looks.reduce((a,b)=>a+b,0),50);assert.deepEqual(events,[]);
});
test('tap attacks; cancelled touch and long press do not',()=>{
 const {g,events,setTime}=fixture();g.down(1,300,400,undefined,390);g.up(1,302,401);g.down(2,300,400,undefined,390);g.up(2,300,400,true);g.down(3,300,400,undefined,390);setTime(500);g.up(3,300,400);assert.deepEqual(events,[['attack']]);
});
test('Z swipe emits one crouch jump macro and releases held crouch',()=>{
 const {g,events}=fixture();g.down(2,340,740,'crouch',390);g.drag(2,340,690);g.drag(2,340,640);g.up(2,340,640);assert.deepEqual(events,[['crouch',true,2],['longJump'],['crouch',false,2]]);
});
test('second movement finger cannot replace origin; reset releases every owner',()=>{
 const {g,events,moves}=fixture();assert.equal(g.down(1,40,500,undefined,390),true);assert.equal(g.down(2,90,510,undefined,390),false);g.down(3,340,740,'crouch',390);g.reset();assert.deepEqual(moves.at(-1),[0,0]);assert.deepEqual(events,[['crouch',true,3],['crouch',false,3]]);
});
