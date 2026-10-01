import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { mergeSave, starCount } from '../shared/save.mjs';

export class WorldStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive:true, mode:0o700});
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS worlds (id TEXT PRIMARY KEY, save BLOB, revision INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lobbies (id TEXT PRIMARY KEY, world TEXT NOT NULL REFERENCES worlds(id), code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL, kind TEXT NOT NULL, guild TEXT, channel TEXT, created INTEGER NOT NULL);`);
  }
  discord(guild, channel) {
    if (![guild, channel].every(value => typeof value === 'string' && /^\d{1,24}$/.test(value))) throw new Error('Invalid Discord location');
    const id = `discord:${guild}:${channel}`;
    return this.byId(id) || this.create(id, `guild:${guild}`, 'Voice channel world', 'discord', guild, channel);
  }
  browser(name) {
    if (this.db.prepare('SELECT COUNT(*) AS count FROM lobbies WHERE kind = ?').get('browser').count >= 4096) throw new Error('World limit reached');
    const id = `browser:${randomUUID()}`;
    return this.create(id, id, cleanName(name, 'Castle courtyard'), 'browser', null, null);
  }
  create(id, world, name, kind, guild, channel) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO worlds (id,updated) VALUES (?,?)').run(world, Date.now());
      this.db.prepare('INSERT INTO lobbies VALUES (?,?,?,?,?,?,?,?)').run(id, world, randomBytes(9).toString('base64url'), name, kind, guild, channel, Date.now());
      this.db.exec('COMMIT'); return this.byId(id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  byId(id) { return this.db.prepare('SELECT * FROM lobbies WHERE id = ?').get(id) || null; }
  byCode(code) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{12}$/.test(code)) return null;
    return this.db.prepare('SELECT * FROM lobbies WHERE code = ?').get(code) || null;
  }
  snapshot(world) {
    const row = this.db.prepare('SELECT * FROM worlds WHERE id = ?').get(world);
    if (!row) throw new Error('Unknown world');
    return { revision:row.revision, updated:row.updated, stars:starCount(row.save), save:row.save ? Buffer.from(row.save).toString('base64') : null };
  }
  save(world, bytes) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM worlds WHERE id = ?').get(world);
      if (!row) throw new Error('Unknown world');
      const previous = row.save ? Buffer.from(row.save) : null;
      const merged = mergeSave(previous, bytes);
      if (!previous?.equals(merged)) this.db.prepare('UPDATE worlds SET save = ?, revision = revision + 1, updated = ? WHERE id = ?').run(merged, Date.now(), world);
      this.db.exec('COMMIT'); return this.snapshot(world);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
export function cleanName(value, fallback='Player') {
  if (typeof value !== 'string') return fallback;
  return Array.from(value.replace(/[\x00-\x1f\x7f\\]/g, '').replace(/\s+/g, ' ').trim()).slice(0,32).join('') || fallback;
}
