// Generated source stays private: some source units include original asset data.
import {readFile,writeFile,rm,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runRust} from './rust-toolchain.mjs';
function run(command,args){const r=spawnSync(command,args,{stdio:'inherit'});if(r.status!==0)throw r.error||new Error(`${command} failed (${r.status})`);}
run('python3',['scripts/port-database.py']);
const db=JSON.parse(await readFile('private/source-port/compile_commands.json'));
const units=db.filter(x=>['src/engine/math_util.c','src/engine/surface_collision.c','src/engine/surface_load.c','src/game/mario.c','src/game/mario_step.c'].some(s=>x.file.endsWith('/'+s))||x.file.includes('/src/game/mario_actions_'));
await writeFile('private/source-port/physics_commands.json',JSON.stringify(units,null,2));
await rm('private/source-port/physics',{recursive:true,force:true});
run(resolve('private/c2rust/bin/c2rust'),['transpile','--emit-build-files','--disable-refactoring','--disable-rustfmt','--fail-on-error','--overwrite-existing','--output-dir','private/source-port/physics','private/source-port/physics_commands.json']);
for(const unit of units){const path='private/source-port/physics/'+unit.file.split('/vendor/coopdx/')[1].replace(/\.c$/,'.rs');if(!(await stat(path)).size)throw new Error('Translation failed: '+unit.file);}
run('python3',['scripts/modernize-translated.py','private/source-port/physics']);
await runRust(['build','--offline','--release','--manifest-path','port/runtime/Cargo.toml','--target','wasm32-unknown-unknown']);
console.log(`Compiled ${units.length} original physics/action source units in Rust. This is not yet a complete Rust game.`);
