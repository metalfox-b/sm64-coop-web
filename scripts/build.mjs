import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { brotliCompress, gzip, constants } from 'node:zlib';
import { promisify } from 'node:util';
const compress=promisify(brotliCompress),compressGzip=promisify(gzip);
const backend='c';
const rustPhysics=process.env.SM64_RUST_PHYSICS==='1';
const engineRoot=process.env.SM64_ENGINE_ROOT||'private/engine';
for(const file of ['sm64.js','sm64.wasm','shell.data'])if(!existsSync(engineRoot+'/'+file))throw new Error(`Build the local game engine first: npm run ${backend==='rust'?'build:rust':'build:engine'}`);
await mkdir('dist/engine',{recursive:true});
await build({entryPoints:['client/activity.mjs'],bundle:true,format:'esm',target:['safari16.4','chrome110'],outfile:'dist/activity.js',minify:true});
for(const file of ['activity.css','icon.svg','manifest.webmanifest'])await copyFile('client/'+file,'dist/'+file);
await copyFile(engineRoot+'/sm64.js','dist/engine/sm64.js');
const bundle=await readFile('dist/activity.js'),css=await readFile('dist/activity.css');
const versionHash=createHash('sha256').update(bundle).update(css);
const downloads=[];
const assetFiles=[engineRoot+'/shell.data'];
for(const file of [engineRoot+'/sm64.wasm',...assetFiles,'dist/engine/sm64.js','dist/activity.js','dist/activity.css']) {
  const bytes=await readFile(file);versionHash.update(bytes);
  const [br,gz]=await Promise.all([compress(bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:6}}),compressGzip(bytes,{level:9})]);
  await writeFile(file+'.br',br);await writeFile(file+'.gz',gz);
  if(file.startsWith('private/'))downloads.push({file:file.slice(engineRoot.length+1),bytes:bytes.length,brotliBytes:br.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
const version=versionHash.digest('hex').slice(0,12);
const html=(await readFile('client/index.html','utf8')).replace('./activity.js',`./activity.js?v=${version}`).replace('./activity.css',`./activity.css?v=${version}`);
await writeFile('dist/index.html',html);await writeFile('dist/runtime.json',JSON.stringify({version,engine:backend==='rust'?'sm64-rust-preview':'sm64coopdx-v1.5.1',nativeAdapter:backend==='c'?'sm64-native-adapter-v1':null,gameplay:backend==='c'?(rustPhysics?'original-mario-physics-rust-mixed-engine':'original-coopdx-c'):'retired-preview',targetFps:60,sharedMemory:false,downloads}));
console.log(`Built activity ${version}. Game data and saves stay outside dist.`);
