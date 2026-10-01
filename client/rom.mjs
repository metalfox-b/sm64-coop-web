export const ROM_SHA256='17ce077343c6133f8c9f2d6d6d9a4ab62c8cd2aa57c40aea1f490b4c8bb21d91';
export const ROM_BYTES=8*1024*1024;
export async function validateROM(bytes) {
  if(!(bytes instanceof ArrayBuffer)||bytes.byteLength!==ROM_BYTES)throw new Error('Choose an unmodified Super Mario 64 USA .z64 ROM (8 MiB).');
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
  if(hash!==ROM_SHA256)throw new Error('This ROM does not match the supported unmodified USA .z64 version.');
  return bytes;
}
function database() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('sm64-local-rom',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('roms');
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
async function stored(mode,operation) {
  const db=await database();
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction('roms',mode),request=operation(tx.objectStore('roms'));
    tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Browser storage unavailable'));
  });}finally{db.close();}
}
export async function loadROM() {
  const bytes=await stored('readonly',store=>store.get(ROM_SHA256));
  return bytes?validateROM(bytes):null;
}
export async function saveROM(bytes) {await validateROM(bytes);await stored('readwrite',store=>store.put(bytes,ROM_SHA256));}
export async function forgetROM() {await stored('readwrite',store=>store.clear());}
