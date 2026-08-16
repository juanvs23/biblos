/**
 * Hybrid score fusion (design: src/hybrid/fusion.ts, decision D5).
 *
 * - semantic_score = max(0, 1 - distance^2 / 2)  -> cosine similarity for
 *   L2-normalized vectors from the vec0 squared-euclidean `distance`.
 * - fts_score = 1 / (1 + |bm25|)                  -> bounded, monotonic per row.
 * - merged = w*semantic + (1-w)*fts, w clamped to [0,1].
 * - Union of both candidate lists; rows in both contribute both components.
 * - Candidates below `minScore` are dropped; empty inputs yield [].
 */
import type { FtsHit, VectorHit } from '../db/store.js';

export type MatchSource = 'semantic' | 'fts' | 'both';

export interface FusionCandidate {
  rowid: number;
  score: number;
  matchedBy: MatchSource;
}

export function semanticScore(distance: number): number {
  return Math.max(0, 1 - (distance * distance) / 2);
}

export function ftsScore(bm25: number): number {
  return 1 / (1 + Math.abs(bm25));
}

export function clampWeight(w: number): number {
  return Math.min(1, Math.max(0, w));
}

interface Work {
  rowid: number;
  sem?: number;
  fts?: number;
}

export function fuse(semantic: VectorHit[], fts: FtsHit[], weight = 0.5, minScore = 0): FusionCandidate[] {
  const w = clampWeight(weight);
  const work = new Map<number, Work>();

  for (const hit of semantic) {
    work.set(hit.rowid, { rowid: hit.rowid, sem: semanticScore(hit.distance) });
  }
  for (const hit of fts) {
    const existing = work.get(hit.rowid);
    if (existing) {
      existing.fts = ftsScore(hit.bm25);
    } else {
      work.set(hit.rowid, { rowid: hit.rowid, fts: ftsScore(hit.bm25) });
    }
  }

  const candidates: FusionCandidate[] = [];
  for (const item of work.values()) {
    const score = w * (item.sem ?? 0) + (1 - w) * (item.fts ?? 0);
    if (score < minScore) continue;
    const matchedBy: MatchSource =
      item.sem !== undefined && item.fts !== undefined ? 'both' : item.sem !== undefined ? 'semantic' : 'fts';
    candidates.push({ rowid: item.rowid, score, matchedBy });
  }
  return candidates.sort((a, b) => b.score - a.score);
}
