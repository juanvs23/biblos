import { describe, expect, it } from 'vitest';

import { clampWeight, ftsScore, fuse, semanticScore } from '../src/hybrid/fusion.js';

describe('fusion scoring', () => {
  it('computes semantic cosine scores from vec0 distance (golden values)', () => {
    expect(semanticScore(0)).toBe(1); // identical vectors
    expect(semanticScore(1)).toBeCloseTo(0.5); // 1 - 1/2
    expect(semanticScore(Math.sqrt(2))).toBeCloseTo(0); // 1 - 2/2 = 0
    expect(semanticScore(10)).toBe(0); // clamped at 0, never negative
  });

  it('computes bounded monotonic FTS scores (golden values)', () => {
    expect(ftsScore(0)).toBe(1);
    expect(ftsScore(-5)).toBeCloseTo(1 / 6);
    expect(ftsScore(3)).toBeCloseTo(0.25);
  });

  it('clamps the fusion weight into [0,1]', () => {
    expect(clampWeight(2)).toBe(1);
    expect(clampWeight(-1)).toBe(0);
    expect(clampWeight(0.5)).toBe(0.5);
  });
});

describe('fuse', () => {
  it('merges only semantic hits with weight 0.5 (half of the semantic score)', () => {
    const out = fuse([{ rowid: 1, distance: 0 }], [], 0.5);
    expect(out).toEqual([{ rowid: 1, score: 0.5, matchedBy: 'semantic' }]);
  });

  it('merges only FTS hits (half of the FTS score)', () => {
    const out = fuse([], [{ rowid: 2, bm25: 0 }], 0.5);
    expect(out).toEqual([{ rowid: 2, score: 0.5, matchedBy: 'fts' }]);
  });

  it('marks rows found by both strategies and blends both components', () => {
    const out = fuse([{ rowid: 1, distance: 0 }], [{ rowid: 1, bm25: 0 }], 0.5);
    expect(out).toEqual([{ rowid: 1, score: 1, matchedBy: 'both' }]); // 0.5*1 + 0.5*1
  });

  it('applies asymmetric weights (w=0.8 favors semantic)', () => {
    const out = fuse([{ rowid: 1, distance: 0 }], [{ rowid: 1, bm25: 0 }], 0.8);
    expect(out[0]?.score).toBeCloseTo(0.8 * 1 + 0.2 * 1);
  });

  it('ranks union candidates by merged score descending', () => {
    const out = fuse(
      [
        { rowid: 1, distance: 0 },
        { rowid: 2, distance: 2 }, // semantic 0
      ],
      [{ rowid: 3, bm25: -1 }], // fts 0.5
      0.5,
    );
    expect(out.map((c) => c.rowid)).toEqual([1, 3, 2]);
    expect(out.map((c) => c.matchedBy)).toEqual(['semantic', 'fts', 'semantic']);
  });

  it('drops candidates below minScore', () => {
    // rowid 1: merged 0.5 (semantic only) | rowid 2: merged 0.25 (fts with bm25=-1)
    const out = fuse([{ rowid: 1, distance: 0 }], [{ rowid: 2, bm25: -1 }], 0.5, 0.4);
    expect(out).toEqual([{ rowid: 1, score: 0.5, matchedBy: 'semantic' }]); // rowid 2 (0.25) dropped

    const allDropped = fuse([{ rowid: 1, distance: 0 }], [], 0.5, 0.6);
    expect(allDropped).toEqual([]);
  });

  it('returns an empty list when both sources are empty (REQ-005)', () => {
    expect(fuse([], [])).toEqual([]);
  });
});
