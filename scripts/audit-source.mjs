import {readdir,readFile,lstat} from 'node:fs/promises';
import {join,relative} from 'node:path';
const roots=['client','server','shared','engine','scripts','rust','port','test'];
const allowed=new Set(['.rs','.mjs','.c','.h','.py','.swift','.md','.json','.toml','.lock','.css','.html','.svg','.webmanifest','.mk','.sh','.example']);
const excluded=new Set(['target','__pycache__']);let files=0;
async function scan(path){
 const st=await lstat(path);if(st.isSymbolicLink())throw new Error('Source symlink: '+path);
 if(st.isDirectory()){for(const x of await readdir(path))if(!excluded.has(x))await scan(join(path,x));return;}
 if(path!=='LICENSE'&&![...allowed].some(ext=>path.endsWith(ext)))throw new Error('Unexpected source file: '+path);
 const bytes=await readFile(path);if(bytes.includes(0)||bytes.length>256*1024)throw new Error('Binary or oversized source: '+path);
 const s=bytes.toString();
 if([...s.matchAll(/https?:\/\/((?:\d{1,3}\.){3}\d{1,3})/g)].some(x=>x[1]!=='127.0.0.1'))throw new Error('Hardcoded server address: '+path);
 if(/BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY/.test(s))throw new Error('Private key: '+path);
 if(/\/Users\/[^/]+\//.test(s))throw new Error('Personal filesystem path: '+path);
 files++;
}
for(const root of roots)await scan(root);
for(const root of ['LICENSE','README.md','package.json','package-lock.json','engine.lock.json','Cargo.toml','.env.example'])await scan(root);
console.log(`Audited ${files} text source/config files; generated assets, ROMs and credentials are excluded.`);
