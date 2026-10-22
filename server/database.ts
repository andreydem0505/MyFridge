import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Batch, Reminder, Settings } from '../shared/model.js';
import { defaultSettings } from '../shared/model.js';

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,batch_id TEXT,kind TEXT,payload TEXT,created_at TEXT);
      CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY,unique_key TEXT UNIQUE,batch_id TEXT,payload TEXT,read_at TEXT,delivered INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS subscriptions(endpoint TEXT PRIMARY KEY,payload TEXT NOT NULL);
    `);
  }
  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT payload FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(String(row.payload)) as T : fallback;
  }
  putSetting(key: string, value: unknown) {
    this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload').run(key, JSON.stringify(value));
  }
  settings() { return this.getSetting<Settings>('preferences', defaultSettings); }
  list(): Batch[] { return this.db.prepare('SELECT payload FROM batches ORDER BY rowid DESC').all().map(r => JSON.parse(String(r.payload))); }
  get(id: string): Batch | undefined {
    const row = this.db.prepare('SELECT payload FROM batches WHERE id=?').get(id);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  save(batch: Batch, kind: string, now: string) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO batches VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(batch.id, JSON.stringify(batch));
      this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(randomUUID(), batch.id, kind, JSON.stringify(batch), now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  history(id: string) {
    return this.db.prepare('SELECT id,kind,created_at FROM events WHERE batch_id=? ORDER BY rowid DESC LIMIT 30').all(id);
  }
  reminders(): Reminder[] {
    const active = new Set(this.list().filter(b => !b.consumedAt).map(b => b.id));
    return this.db.prepare('SELECT payload,read_at FROM reminders ORDER BY rowid DESC LIMIT 200').all()
      .map(r => ({ ...JSON.parse(String(r.payload)), readAt: r.read_at ? String(r.read_at) : null }) as Reminder)
      .filter(r => active.has(r.batchId));
  }
  createReminder(reminder: Reminder, key: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO reminders(id,unique_key,batch_id,payload) VALUES (?,?,?,?)')
      .run(reminder.id, key, reminder.batchId, JSON.stringify(reminder)).changes > 0;
  }
  pendingPush(): Reminder[] {
    const active = new Set(this.list().filter(b => !b.consumedAt).map(b => b.id));
    return this.db.prepare('SELECT payload FROM reminders WHERE delivered=0 AND read_at IS NULL LIMIT 100').all()
      .map(r => JSON.parse(String(r.payload)) as Reminder).filter(r => active.has(r.batchId));
  }
  markRead(id: string, now: string) {
    if (id === 'all') this.db.prepare('UPDATE reminders SET read_at=? WHERE read_at IS NULL').run(now);
    else this.db.prepare('UPDATE reminders SET read_at=? WHERE id=?').run(now, id);
  }
  clearDemo() {
    for (const b of this.list().filter(b => b.demo)) {
      this.db.prepare('DELETE FROM reminders WHERE batch_id=?').run(b.id);
      this.db.prepare('DELETE FROM events WHERE batch_id=?').run(b.id);
      this.db.prepare('DELETE FROM batches WHERE id=?').run(b.id);
    }
  }
  close() { this.db.close(); }
}
