import {cp,mkdir,readFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const source=process.env.SM64_ENGINE_ROOT||'private/engine',out=resolve('private/release');
const runtime=JSON.parse(await readFile('dist/runtime.json'));
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
for(const name of ['dist','server','shared','LICENSE','package.json','node_modules/ws'])await cp(name,resolve(out,name),{recursive:true});
await mkdir(resolve(out,'engine'));
for(const name of ['sm64.wasm','shell.data']) {
  const bytes=await readFile(source+'/'+name);
  if(createHash('sha256').update(bytes).digest('hex')!==runtime.downloads.find(x=>x.file===name)?.sha256)throw new Error('Engine does not match the built site');
  for(const suffix of ['','.br','.gz'])await cp(source+'/'+name+suffix,resolve(out,'engine',name+suffix));
}
console.log('Created private/release. Configure its own .env; keep your ROM local.');
