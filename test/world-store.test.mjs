import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldStore } from '../server/world-store.mjs';
import { signSlot, activeSlot, starCount } from '../shared/save.mjs';

function save(stars=0,flags=1,coins=0) {
  const bytes=Buffer.alloc(512),slot=bytes.subarray(0,56);slot.writeUInt32BE(flags,8);slot[12]=stars;slot[37]=coins;signSlot(slot);slot.copy(bytes,56);return bytes;
}
test('voice-channel identity survives an Activity relaunch; guild progression is shared',()=>{
  const store=new WorldStore(':memory:');
  try {
    const a=store.discord('100','200'),b=store.discord('100','201'),other=store.discord('101','200');
    assert.equal(store.discord('100','200').code,a.code);assert.notEqual(a.id,b.id);assert.equal(a.world,b.world);assert.notEqual(a.world,other.world);
    store.save(a.world,save(1));assert.equal(store.snapshot(b.world).stars,1);assert.equal(store.snapshot(other.world).stars,0);
  }finally{store.close();}
});
test('stale saves from simultaneous channels preserve stars, cannon flags, doors and records',()=>{
  const store=new WorldStore(':memory:');
  try {
    const room=store.discord('100','200');
    store.save(room.world,save(0x81,0x11,120));
    const merged=store.save(room.world,save(2,0x41,50)),slot=activeSlot(Buffer.from(merged.save,'base64'));
    assert.equal(merged.stars,2);assert.equal(slot[12],0x83);assert.equal(slot[37],120);assert.equal(slot.readUInt32BE(8),0x41);
    const revision=merged.revision;assert.equal(store.save(room.world,save(2,0x41,50)).revision,revision);
  }finally{store.close();}
});
test('worlds and durable lobby codes survive service restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'sm64-world-test-')),path=join(dir,'worlds.sqlite');let store=new WorldStore(path);
  try {
    const room=store.browser('Friends');store.save(room.world,save(3));const code=room.code;store.close();store=new WorldStore(path);
    const restored=store.byCode(code);assert.equal(restored.name,'Friends');assert.equal(store.snapshot(restored.world).stars,2);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('a damaged primary is repaired from backup; invalid saves leave progress untouched',()=>{
  const store=new WorldStore(':memory:');
  try {
    const room=store.browser('Friends'),bytes=save(1);bytes[0]=200;
    assert.equal(store.save(room.world,bytes).stars,1);
    assert.throws(()=>store.save(room.world,Buffer.alloc(512)),/checksum/);
    assert.equal(store.snapshot(room.world).stars,1);
    const raw=Buffer.from(store.snapshot(room.world).save,'base64');assert.deepEqual(raw.subarray(0,56),raw.subarray(56,112));
  }finally{store.close();}
});
test('browser-created worlds have independent saves',()=>{
  const store=new WorldStore(':memory:');try{const a=store.browser('A'),b=store.browser('B');store.save(a.world,save(1));assert.equal(store.snapshot(b.world).stars,0);}finally{store.close();}
});
test('castle secret stars stored in progress flags count toward the world total',()=>{
  assert.equal(starCount(save(1,0x11000001)),3);
});
