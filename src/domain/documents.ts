/**
 * Document domain service (design: src/domain/documents.ts, tasks 4.2).
 *
 * - save: validate -> embed FIRST (D6) -> atomic store txn (doc + fts + vec).
 * - update: re-embed only when content changed; metadata-only updates skip the router.
 * - delete: atomic removal of doc + embedding + relation edges.
 * - search: embed query -> vec0 kNN (k=50) + FTS (k=50) -> fuse -> top limit.
 */
import { randomUUID } from 'node:crypto';

import type { DocumentPatch, Store } from '../db/store.js';
import type { EmbeddingClient } from '../embeddings/client.js';
import { fuse } from '../hybrid/fusion.js';
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
  fusionWeight?: number;
}

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 100;
export const VECTOR_CANDIDATES = 50;
const DEFAULT_LIST_LIMIT = 50;

export class DocumentsService {
  constructor(
    private readonly store: Store,
    private readonly embeddings: EmbeddingClient,
    private readonly defaults: { fusionWeight: number; minScore: number },
  ) {}

  /** Validate then embed-then-persist; router failure never leaves partial rows (D6, REQ-core-embeddings). */
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
    const embedding = await this.embeddings.embed(input.content);
    this.store.insertDocument(doc, embedding);
    return doc;
  }

  get(id: string): DocumentRecord {
    const doc = this.store.getDocument(id);
    if (!doc) throw new DomainError('not_found', `document ${id} not found`);
    return doc;
  }

  /** Re-embed only on content change; metadata-only updates keep the stored vector (REQ-memory-update). */
  async update(id: string, patch: DocumentUpdate): Promise<DocumentRecord> {
    if (patch.content !== undefined && patch.content.length === 0) {
      throw new DomainError('invalid_document', 'document content must not be empty');
    }
    const existing = this.get(id);
    const contentChanged = patch.content !== undefined && patch.content !== existing.content;

    let reembed: number[] | undefined;
    if (contentChanged) {
      reembed = await this.embeddings.embed(patch.content as string);
    }

    const next: DocumentPatch = {};
    if (patch.content !== undefined) next.content = patch.content;
    if (patch.author !== undefined) next.author = patch.author;
    if (patch.tags !== undefined) next.tags = patch.tags;
    if (patch.project !== undefined) next.project = patch.project;
    if (patch.type !== undefined) next.type = patch.type;
    if (Object.keys(next).length === 0) {
      throw new DomainError('invalid_document', 'update requires at least one field');
    }

    this.store.updateDocument(id, next, reembed);
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
    const embedding = await this.embeddings.embed(query); // router failure -> surfaced error, no writes
    const semantic = this.store.vectorSearch(embedding, VECTOR_CANDIDATES);
    const fts = this.store.ftsSearch(query, VECTOR_CANDIDATES);
    const candidates = fuse(semantic, fts, options.fusionWeight ?? this.defaults.fusionWeight, this.defaults.minScore);

    const hits: SearchHit[] = [];
    for (const candidate of candidates) {
      const document = this.store.getDocumentByRowid(candidate.rowid);
      if (document) hits.push({ document, score: candidate.score, matchedBy: candidate.matchedBy });
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
