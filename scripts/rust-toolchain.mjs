import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
export const root=resolve(import.meta.dirname,'..');
const bins=[process.env.SM64_RUST_BIN,resolve(root,'private/toolchain/cargo/bin')].filter(Boolean);
const bin=bins.find(path=>existsSync(resolve(path,'cargo')));
export const rustEnv={...process.env,SM64_REFERENCE:process.env.SM64_REFERENCE||resolve(root,'vendor/coopdx'),CARGO_HOME:resolve(root,'private/cargo-cache'),
  ...(bin?{PATH:bin+':'+process.env.PATH,RUSTUP_HOME:process.env.RUSTUP_HOME||resolve(dirname(dirname(bin)),'rustup')}:{})};
export function runRust(args,{capture=false}={}) {
  return new Promise((accept,reject)=>{
    const child=spawn(bin?resolve(bin,'cargo'):'cargo',args,{cwd:root,env:rustEnv,stdio:capture?['ignore','pipe','pipe']:'inherit'});
    let output='';if(capture){child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);}
    child.on('error',reject);child.on('exit',code=>code===0?accept(output):reject(new Error(`cargo ${args[0]} failed (${code})${capture?'\n'+output:''}`)));
  });
}
