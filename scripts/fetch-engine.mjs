import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const lock = JSON.parse(await readFile(new URL('../engine.lock.json', import.meta.url), 'utf8'));
export async function unpack(url, hash, archive, destination) {
  await mkdir('vendor', { recursive: true });
  let bytes = await readFile(archive).catch(() => null);
  const digest = data => createHash('sha256').update(data).digest('hex');
  if (!bytes || digest(bytes) !== hash) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Source download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes) !== hash) throw new Error(`Source checksum mismatch: ${url}`);
    await writeFile(archive, bytes);
  }
  await mkdir(destination, { recursive: true });
  const result = spawnSync('tar', ['-xzf', archive, '--strip-components=1', '-C', destination], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Source extraction failed');
}
await unpack(lock.archive, lock.sha256, 'vendor/coopdx-source.tar.gz', 'vendor/coopdx');
await unpack(lock.lua.archive, lock.lua.sha256, 'vendor/lua-source.tar.gz', 'vendor/lua');
console.log(`Verified Coop Deluxe ${lock.version} and Lua 5.3.6 sources.`);
