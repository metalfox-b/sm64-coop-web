import {runRust,rustEnv} from './rust-toolchain.mjs';
import {spawnSync} from 'node:child_process';
// The first locked install populates Cargo's source cache. The second installs
// the reviewed compatibility patches from prepare-translator.py.
await runRust(['install','--locked','--version','0.22.1','c2rust','--root','private/c2rust']);
const patched=spawnSync('python3',['scripts/prepare-translator.py'],{stdio:'inherit',env:rustEnv});
if(patched.status!==0)throw new Error('Translator patch preparation failed');
await runRust(['install','--locked','--force','--path','private/c2rust-source/c2rust','--root','private/c2rust']);
