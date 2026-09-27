/**
 * Document domain service (design: src/domain/documents.ts).
 *
 * - save: validate -> atomic store insert (FTS row synced by trigger).
 * - update: apply the patch; the FTS index is refreshed by trigger.
 * - delete: atomic removal of doc + relation edges.
 * - search: FTS5 keyword search (bm25-ranked, best match first) ->
 *   normalize -> minScore threshold -> limit.
 */
import { randomUUID } from 'node:crypto';

import { ftsScore, type DocumentPatch, type Store } from '../db/store.js';
import { DomainError } from './errors.js';
import type { DocumentRecord, SearchHit } from './types.js';

export interface DocumentInput {
  content: string;
  author: string;
  tags?: string[];
  project?: string;
  type?: string;
}

export interface DocumentUpdate {
  content?: string;
  author?: string;
  tags?: string[];
  project?: string | null;
  type?: string;
}

export interface ListOptions {
  project?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface SearchOptions {
  limit?: number;
}

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 100;
export const FTS_CANDIDATES = 100;
// Candidate pool for FTS search. Must stay >= the search tool's MAX_SEARCH_LIMIT
// (100) so a high limit never silently truncates results.
const DEFAULT_LIST_LIMIT = 50;

export class DocumentsService {
  constructor(
    private readonly store: Store,
    private readonly defaults: { minScore: number },
  ) {}

  /** Validate then persist; returns the stored document (REQ-memory-save). */
  async save(input: DocumentInput): Promise<DocumentRecord> {
    validateSave(input);
    const now = new Date().toISOString();
    const doc: DocumentRecord = {
      id: randomUUID(),
      content: input.content,
      author: input.author,
      createdAt: now,
      updatedAt: now,
      tags: input.tags ?? [],
      project: input.project,
      type: input.type ?? 'note',
    };
    this.store.insertDocument(doc);
    return doc;
  }

  get(id: string): DocumentRecord {
    const doc = this.store.getDocument(id);
    if (!doc) throw new DomainError('not_found', `document ${id} not found`);
    return doc;
  }

  /** Apply the patch and refresh updated_at; the FTS index is kept in sync by trigger (REQ-memory-update). */
  async update(id: string, patch: DocumentUpdate): Promise<DocumentRecord> {
    if (patch.content !== undefined && patch.content.length === 0) {
      throw new DomainError('invalid_document', 'document content must not be empty');
    }
    this.get(id);

    const next: DocumentPatch = {};
    if (patch.content !== undefined) next.content = patch.content;
    if (patch.author !== undefined) next.author = patch.author;
    if (patch.tags !== undefined) next.tags = patch.tags;
    if (patch.project !== undefined) next.project = patch.project;
    if (patch.type !== undefined) next.type = patch.type;
    if (Object.keys(next).length === 0) {
      throw new DomainError('invalid_document', 'update requires at least one field');
    }

    this.store.updateDocument(id, next);
    return this.get(id);
  }

  delete(id: string): void {
    const existed = this.store.deleteDocument(id);
    if (!existed) throw new DomainError('not_found', `document ${id} not found`);
  }

  list(options: ListOptions = {}): DocumentRecord[] {
    return this.store.listDocuments({
      project: options.project,
      tags: options.tags,
      limit: options.limit ?? DEFAULT_LIST_LIMIT,
      offset: options.offset ?? 0,
    });
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
    const hits: SearchHit[] = [];
    // ftsSearch returns hits best-first (ORDER BY bm25 ascending: FTS5 assigns
    // better matches smaller, more negative values); keep that order.
    for (const hit of this.store.ftsSearch(query, FTS_CANDIDATES)) {
      const score = ftsScore(hit.bm25);
      if (score < this.defaults.minScore) continue;
      const document = this.store.getDocumentByRowid(hit.rowid);
      if (document) hits.push({ document, score });
      if (hits.length >= limit) break;
    }
    return hits;
  }
}

function validateSave(input: DocumentInput): void {
  if (typeof input.content !== 'string' || input.content.trim().length === 0) {
    throw new DomainError('invalid_document', 'document content must be a non-empty string');
  }
  if (typeof input.author !== 'string' || input.author.trim().length === 0) {
    throw new DomainError('invalid_document', 'document author is required');
  }
}
