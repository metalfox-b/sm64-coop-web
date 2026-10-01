import { existsSync } from 'node:fs';
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import {runRust} from './rust-toolchain.mjs';
const lock = JSON.parse(await readFile('engine.lock.json', 'utf8'));
const rom = process.env.SM64_ROM;
const rustPhysics=process.env.SM64_RUST_PHYSICS==='1';
const destination=rustPhysics?'private/rust-source-engine':'private/engine';
if (!rom) throw new Error('Set SM64_ROM to the local Super Mario 64 USA .z64 path.');
const bytes = await readFile(rom);
if (createHash('sha256').update(bytes).digest('hex') !== lock.romSha256) throw new Error('Expected the vanilla US big-endian ROM.');
await copyFile(rom, 'vendor/coopdx/baserom.us.z64');
const emcc = process.env.EMCC || 'emcc';
const emxx = emcc === 'emcc' ? 'em++' : resolve(dirname(emcc), 'em++');
function run(command, args, cwd) {
  const result = spawnSync(command, args, {cwd, stdio:'inherit',env:{...process.env,EM_CACHE:resolve('vendor/emscripten-cache')}});
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} failed (${result.status})`);
}
run('python3', ['scripts/prepare-engine.py']);
run('python3', ['scripts/fix-webgl.py']);
run('python3', ['scripts/prepare-local-rom.py']);
// Warm the SDK ports before Clang reads their headers for translation.
await mkdir('private', {recursive:true});
run(emcc,['-sUSE_SDL=2','-sUSE_ZLIB=1','-x','c','-c','/dev/null','-o','private/wasm-platform.o']);
if(rustPhysics)run(process.execPath,['scripts/translate-original.mjs']);
else await runRust(['build','--release','-p','sm64-native-adapter','--target','wasm32-unknown-unknown']);
run('make', [`RUST_PHYSICS=${rustPhysics?1:0}`,'-W',rustPhysics?'../../port/runtime/target/wasm32-unknown-unknown/release/libsm64_original_runtime.a':'../../target/wasm32-unknown-unknown/release/libsm64_native_adapter.a','-j' + (process.env.SM64_BUILD_JOBS || '8'), 'HOST_OS=Web', 'TARGET_BITS=32', 'DISCORD_SDK=0', 'COOPNET=0', 'UPDATER=0', 'ICON=0', 'USE_APP=0', 'COMPILER=clang', 'DEBUG_INFO_LEVEL=0', `EMCC=${emcc}`, `EMXX=${emxx}`], resolve('vendor/coopdx'));
await mkdir(destination, {recursive:true});
for (const file of ['sm64.js','sm64.wasm','sm64.data']) await copyFile(`vendor/coopdx/build/us_pc/${file}`, `${destination}/${file==='sm64.data'?'shell.data':file}`);
console.log(`Built ${rustPhysics?'translated original Rust physics':'original C reference'} browser runtime. Assets remain in ignored ${destination}.`);
