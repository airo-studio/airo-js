/**
 * SQLite-backed cartridge state store. v0 of Lane D's persistence layer.
 *
 * Uses Node 22+'s built-in `node:sqlite` (stable in Node 23+) — zero
 * native deps, zero compile step. Append-only history: every save inserts
 * a new row keyed by an autoincrement primary key that doubles as the
 * design doc's monotonic `revision_id`. No updates, no deletes; future
 * slices may add a /api/history endpoint or "rollback to revision N".
 *
 * The DB file lives at apps/studio-lite/.studio-data/db.sqlite —
 * gitignored, per-checkout.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

interface CartridgeStateRow {
  revision_id: number;
  cartridge_id: string;
  data: string;
  created_at: number;
}

export interface CartridgeState {
  revisionId: number;
  cartridgeId: string;
  data: unknown;
  createdAt: number;
}

export class CartridgeStateStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // WAL improves concurrency; v0 is single-process so this is mostly future-proofing.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS cartridge_state (
        revision_id  INTEGER PRIMARY KEY AUTOINCREMENT,
        cartridge_id TEXT    NOT NULL,
        data         TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cartridge_state_latest
        ON cartridge_state (cartridge_id, revision_id DESC);
    `);
  }

  /**
   * Persist a new state snapshot. Returns the new revision (autoincrement
   * primary key) — strictly monotonic across all cartridges in this store.
   */
  save(cartridgeId: string, data: unknown): CartridgeState {
    const json = JSON.stringify(data);
    const now = Date.now();
    const stmt = this.db.prepare(
      'INSERT INTO cartridge_state (cartridge_id, data, created_at) VALUES (?, ?, ?)',
    );
    const result = stmt.run(cartridgeId, json, now);
    return {
      revisionId: Number(result.lastInsertRowid),
      cartridgeId,
      data,
      createdAt: now,
    };
  }

  /** Latest persisted state for a cartridge, or undefined if no save yet. */
  latest(cartridgeId: string): CartridgeState | undefined {
    const row = this.db
      .prepare(
        'SELECT revision_id, cartridge_id, data, created_at FROM cartridge_state WHERE cartridge_id = ? ORDER BY revision_id DESC LIMIT 1',
      )
      .get(cartridgeId) as CartridgeStateRow | undefined;
    if (!row) return undefined;
    return rowToState(row);
  }

  /** Total saves for a cartridge — used in /healthz diagnostics. */
  countByCartridge(cartridgeId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM cartridge_state WHERE cartridge_id = ?')
      .get(cartridgeId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

function rowToState(row: CartridgeStateRow): CartridgeState {
  return {
    revisionId: row.revision_id,
    cartridgeId: row.cartridge_id,
    data: JSON.parse(row.data) as unknown,
    createdAt: row.created_at,
  };
}
