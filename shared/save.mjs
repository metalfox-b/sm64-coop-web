// Vanilla US EEPROM layout, verified against Coop Deluxe's SaveFile/SaveBuffer.
export const EEPROM_BYTES = 512;
export const SAVE_BYTES = 56;
export const COURSE_COUNT = 25;
export function checksum(bytes) { return bytes.subarray(0, bytes.length - 2).reduce((sum, value) => (sum + value) & 65535, 0); }
export function validSlot(slot) {
  return slot?.length === SAVE_BYTES && slot.readUInt16BE(52) === 0x4441 && slot.readUInt16BE(54) === checksum(slot);
}
export function signSlot(slot) {
  slot.writeUInt16BE(0x4441, 52); slot.writeUInt16BE(checksum(slot), 54); return slot;
}
export function activeSlot(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== EEPROM_BYTES) throw new Error('Expected a 512-byte EEPROM save');
  const primary = bytes.subarray(0, SAVE_BYTES), backup = bytes.subarray(SAVE_BYTES, SAVE_BYTES * 2);
  if (validSlot(primary)) return primary;
  if (validSlot(backup)) return backup;
  throw new Error('Save A has no valid checksum');
}
export function mergeSave(previous, incoming) {
  const fresh = activeSlot(incoming);
  const merged = Buffer.from(previous || incoming);
  const slot = Buffer.from(fresh);
  if (previous) {
    const old = activeSlot(previous);
    let flags = (old.readUInt32BE(8) | fresh.readUInt32BE(8)) >>> 0;
    // Consumed keys must stay consumed once their door is unlocked.
    if (flags & 0x40) flags &= ~0x10;
    if (flags & 0x80) flags &= ~0x20;
    slot.writeUInt32BE(flags >>> 0, 8);
    for (let i = 12; i < 37; i++) slot[i] |= old[i];
    for (let i = 37; i < 52; i++) slot[i] = Math.max(slot[i], old[i]);
  }
  signSlot(slot);
  slot.copy(merged, 0); slot.copy(merged, SAVE_BYTES);
  return merged;
}
export function starCount(bytes) {
  if (!bytes) return 0;
  const slot = activeSlot(Buffer.from(bytes));
  let count = 0, castleStars = (slot.readUInt32BE(8) >>> 24) & 0x7f;
  while (castleStars) { count += castleStars & 1; castleStars >>>= 1; }
  for (let i = 12; i < 37; i++) {
    let bits = slot[i] & 0x7f;
    while (bits) { count += bits & 1; bits >>>= 1; }
  }
  return count;
}
export function decodeSave(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{683}=$/.test(value)) throw new Error('Invalid EEPROM encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== EEPROM_BYTES || bytes.toString('base64') !== value) throw new Error('Invalid EEPROM encoding');
  activeSlot(bytes); return bytes;
}
