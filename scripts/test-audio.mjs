import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
export async function testAudio(page,output,checks) {
  await page.evaluate(()=>{const m=window.SM64Activity.module;m.webSoundTrace=true;m.webSoundEvents=[];m._web_audio_probe(1);});
  await page.waitForFunction(()=>window.SM64Activity.diagnostics.level===6,{},{timeout:30000});
  await page.waitForTimeout(3500);
  await page.keyboard.down('KeyW');await page.waitForTimeout(3500);await page.keyboard.up('KeyW');
  const result=await page.evaluate(()=>{const m=window.SM64Activity.module;m._web_audio_probe(0);return {events:m.webSoundEvents,samples:m.webAudioSamples,diagnostics:window.SM64Activity.diagnostics};});
  await writeFile(resolve(output,'audio.json'),JSON.stringify(result,null,2));
  await page.screenshot({path:resolve(output,'castle-audio.png')});
  const steps=result.events.filter(x=>(x.sound&0xfff00000)===0x06100000);
  assert.ok(steps.length,'recorded castle footstep events');
  assert.ok(steps.every(x=>x.addend===3<<16 && ((x.sound>>>16)&255)===0x13),'castle selects stone footsteps');
  const bank=JSON.parse(await readFile('vendor/coopdx/sound/sound_banks/01_terrain.json','utf8'));
  const offsets=await readFile('vendor/coopdx/sound/samples_offsets.h','utf8');
  const assets=await readFile('vendor/coopdx/sound/samples_assets.c','utf8');
  const rom=await readFile(process.env.SM64_ROM);
  for(let i=0;i<bank.instrument_list.length;i++) {
    const name=bank.instrument_list[i];if(!name)continue;
    const symbol='sfx_terrain_'+bank.instruments[name].sound+'_aifc';
    const offset=Number(offsets.match(new RegExp('#define SAMPLE_'+symbol+' (0x[0-9a-f]+)'))[1]);
    const declaration=assets.split('\n').find(line=>line.startsWith('ROM_ASSET_LOAD_SAMPLE('+symbol+','));
    const fields=declaration.slice(declaration.indexOf('(')+1,-2).split(',');
    const address=Number(fields[2]),size=Number(fields[3]);
    const sample=result.samples.find(x=>x.instrument===i);
    assert.equal(sample?.offset,offset,'original terrain sample mapping: '+name);
    assert.equal(sample.size,size,'original terrain sample size: '+name);
    assert.deepEqual(sample.bytes,[...rom.subarray(address,address+Math.min(size,32))],'local ROM terrain sample bytes: '+name);
  }
  checks.push({check:'castle footstep selection',steps,samples:result.samples});
}
