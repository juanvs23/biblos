/**
 * Sync persistence facade over a single better-sqlite3 connection (design: src/db/store.ts).
 * CRUD is single-statement: statement-level atomicity plus FK cascade keep
 * write operations all-or-nothing; SQLITE_BUSY/LOCKED and constraint errors
 * surface (never swallowed).
 */
import Database from 'better-sqlite3';

import { migrate } from './migrate.js';
import type { AgentRecord, BusRequest, DocumentRecord, Relation, RequestState } from '../domain/types.js';

export interface DocumentFilters {
  project?: string;
  tags?: string[];
  limit: number;
  offset: number;
}

/** Update patch: metadata may clear `project` with an explicit null. */
export type DocumentPatch = Partial<Omit<DocumentRecord, 'project'>> & { project?: string | null };

export interface FtsHit {
  rowid: number;
  bm25: number;
}

export interface GraphQuery {
  nodes: string[];
  edges: Relation[];
}

export interface RespondResult {
  state: 'completada' | 'fallida';
  result: unknown;
}

interface DocumentRow {
  rowid: number;
  id: string;
  content: string;
  author: string;
  created_at: string;
  updated_at: string;
  tags: string;
  project: string | null;
  type: string;
}

interface RequestRow {
  id: string;
  sender: string;
  recipient: string;
  payload: string;
  state: RequestState;
  result: string | null;
  created_at: string;
}

interface AgentRow {
  name: string;
  type: string;
  capabilities: string;
  created_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/**
 * Escape a user query into FTS5-safe quoted tokens (AND semantics). Raw MATCH
 * input with punctuation like `"` or `:` raises FTS5 syntax errors.
 */
export function sanitizeFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' ');
}

/**
 * Normalize an FTS5 bm25 rank into (0, 1]. Kept from the removed hybrid layer
 * so BIBLOS_MIN_SCORE keeps its established score semantics. NOTE: FTS5 assigns
 * better matches SMALLER (more negative) bm25 values, so the best hit gets the
 * LOWEST normalized score — relevance ranking is ftsSearch's bm25-ascending
 * order, not this score.
 */
export function ftsScore(bm25: number): number {
  return 1 / (1 + Math.abs(bm25));
}

function mapDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    content: row.content,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: JSON.parse(row.tags) as string[],
    project: row.project ?? undefined,
    type: row.type,
  };
}

function mapAgent(row: AgentRow): AgentRecord {
  return {
    name: row.name,
    type: row.type,
    capabilities: JSON.parse(row.capabilities) as string[],
    createdAt: row.created_at,
  };
}

function mapRequest(row: RequestRow): BusRequest {
  return {
    id: row.id,
    sender: row.sender,
    recipient: row.recipient,
    payload: JSON.parse(row.payload) as unknown,
    state: row.state,
    result: row.result === null ? undefined : (JSON.parse(row.result) as unknown),
    createdAt: row.created_at,
  };
}

export class Store {
  constructor(private readonly db: Database.Database) {}

  close(): void {
    this.db.close();
  }

  // --- documents ---

  /** Insert a document; the FTS row is synced by the documents_ai trigger. */
  insertDocument(doc: DocumentRecord): void {
    this.db
      .prepare(
        `INSERT INTO documents (id, content, author, created_at, updated_at, tags, project, type)
         VALUES (@id, @content, @author, @createdAt, @updatedAt, @tags, @project, @type)`,
      )
      .run({
        id: doc.id,
        content: doc.content,
        author: doc.author,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        tags: JSON.stringify(doc.tags),
        project: doc.project ?? null,
        type: doc.type,
      });
  }

  /** Update content/metadata and refresh updated_at; the FTS index is synced by the documents_au trigger. */
  updateDocument(id: string, patch: DocumentPatch): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.content !== undefined) {
      sets.push('content = @content');
      params.content = patch.content;
    }
    if (patch.author !== undefined) {
      sets.push('author = @author');
      params.author = patch.author;
    }
    if (patch.tags !== undefined) {
      sets.push('tags = @tags');
      params.tags = JSON.stringify(patch.tags);
    }
    if (patch.project !== undefined) {
      sets.push('project = @project');
      params.project = patch.project;
    }
    if (patch.type !== undefined) {
      sets.push('type = @type');
      params.type = patch.type;
    }
    sets.push(`updated_at = ${NOW}`);
    this.db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  /** Deletes the documents row; FTS row and relation edges are removed by trigger/FK cascade. Returns true if the doc existed. */
  deleteDocument(id: string): boolean {
    const exists = this.db.prepare('SELECT 1 FROM documents WHERE id = ?').get(id);
    if (!exists) return false;
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    return true;
  }

  getDocument(id: string): DocumentRecord | null {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined;
    return row ? mapDocument(row) : null;
  }

  /** Lookup used by search, where FTS candidates arrive as rowids. */
  getDocumentByRowid(rowid: number): DocumentRecord | null {
    const row = this.db.prepare('SELECT * FROM documents WHERE rowid = ?').get(rowid) as DocumentRow | undefined;
    return row ? mapDocument(row) : null;
  }

  listDocuments(f: DocumentFilters): DocumentRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.project !== undefined) {
      where.push('project = ?');
      params.push(f.project);
    }
    for (const tag of f.tags ?? []) {
      where.push('EXISTS (SELECT 1 FROM json_each(documents.tags) WHERE json_each.value = ?)');
      params.push(tag);
    }
    const sql = `SELECT * FROM documents${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`;
    return (this.db.prepare(sql).all(...params, f.limit, f.offset) as DocumentRow[]).map(mapDocument);
  }

  // --- FTS search ---

  ftsSearch(query: string, k: number): FtsHit[] {
    const q = sanitizeFtsQuery(query);
    if (q === '') return [];
    return this.db
      .prepare('SELECT rowid, bm25(documents_fts) AS bm25 FROM documents_fts WHERE documents_fts MATCH ? ORDER BY bm25 LIMIT ?')
      .all(q, k) as FtsHit[];
  }

  // --- relations / graph ---

  /** No-op when the exact relation already exists; FK violations (unknown nodes) surface. */
  addRelation(r: Relation): void {
    const exists = this.db
      .prepare('SELECT 1 FROM relations WHERE source_id = ? AND type = ? AND target_id = ?')
      .get(r.sourceId, r.type, r.targetId);
    if (exists) return;
    this.db.prepare('INSERT INTO relations (source_id, type, target_id) VALUES (?, ?, ?)').run(r.sourceId, r.type, r.targetId);
  }

  removeRelation(r: Relation): void {
    this.db.prepare('DELETE FROM relations WHERE source_id = ? AND type = ? AND target_id = ?').run(r.sourceId, r.type, r.targetId);
  }

  /** All relations in insertion order — used by full-graph render. */
  listRelations(): Relation[] {
    return this.db
      .prepare('SELECT source_id AS sourceId, type, target_id AS targetId FROM relations ORDER BY id')
      .all() as Relation[];
  }

  /** Breadth-first traversal over outgoing relations, optionally filtered by type. */
  queryGraph(start: string, type: string | undefined, depth: number): GraphQuery {
    const nodes = new Set<string>([start]);
    const edges: Relation[] = [];
    let frontier = [start];
    for (let level = 0; level < depth; level++) {
      const next: string[] = [];
      for (const node of frontier) {
        const rows =
          type === undefined
            ? (this.db
                .prepare('SELECT source_id AS sourceId, type, target_id AS targetId FROM relations WHERE source_id = ?')
                .all(node) as Relation[])
            : (this.db
                .prepare(
                  'SELECT source_id AS sourceId, type, target_id AS targetId FROM relations WHERE source_id = ? AND type = ?',
                )
                .all(node, type) as Relation[]);
        for (const edge of rows) {
          edges.push(edge);
          if (!nodes.has(edge.targetId)) {
            nodes.add(edge.targetId);
            next.push(edge.targetId);
          }
        }
      }
      frontier = next;
    }
    return { nodes: [...nodes], edges };
  }

  // --- agent registry ---

  registerAgent(a: AgentRecord): void {
    this.db
      .prepare('INSERT INTO agents (name, type, capabilities, created_at) VALUES (?, ?, ?, ?)')
      .run(a.name, a.type, JSON.stringify(a.capabilities), a.createdAt);
  }

  assertAgent(name: string): boolean {
    return this.db.prepare('SELECT 1 FROM agents WHERE name = ?').get(name) !== undefined;
  }

  getAgent(name: string): AgentRecord | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as AgentRow | undefined;
    return row ? mapAgent(row) : null;
  }

  listAgents(): AgentRecord[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY name').all() as AgentRow[]).map(mapAgent);
  }

  // --- bus ---

  enqueue(r: BusRequest): void {
    this.db
      .prepare('INSERT INTO requests (id, sender, recipient, payload, state) VALUES (?, ?, ?, ?, ?)')
      .run(r.id, r.sender, r.recipient, JSON.stringify(r.payload ?? null), 'pendiente');
  }

  /** Oldest pendiente request for the recipient, atomically claimed (→ en-proceso). */
  claim(recipient: string): BusRequest | null {
    const row = this.db
      .prepare("SELECT * FROM requests WHERE recipient = ? AND state = 'pendiente' ORDER BY created_at, id LIMIT 1")
      .get(recipient) as RequestRow | undefined;
    if (!row) return null;
    this.db
      .prepare(`UPDATE requests SET state = 'en-proceso', claimed_at = ${NOW}, updated_at = ${NOW} WHERE id = ?`)
      .run(row.id);
    return { ...mapRequest(row), state: 'en-proceso' as const };
  }

  /** Respond to a claimed request; returns false when id/recipient/state do not match. */
  respond(id: string, result: RespondResult, recipient: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE requests SET state = ?, result = ?, updated_at = ${NOW}
         WHERE id = ? AND recipient = ? AND state = 'en-proceso'`,
      )
      .run(result.state, result.result === undefined ? null : JSON.stringify(result.result), id, recipient);
    return info.changes > 0;
  }

  status(id: string): BusRequest | null {
    const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as RequestRow | undefined;
    return row ? mapRequest(row) : null;
  }
}

/** Open (or create) the SQLite file and run the idempotent boot migration. */
export function openStore(dbPath: string): Store {
  const db = new Database(dbPath);
  migrate(db);
  return new Store(db);
}
