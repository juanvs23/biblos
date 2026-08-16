/**
 * E2E — hybrid search over the REAL built server (task 8.2, REQ-memory-search).
 *
 * The embedding router is stubbed with a local HTTP endpoint serving FIXED
 * deterministic vectors (bag-of-words, same as the unit-test seam) — no
 * llama.cpp required. The server talks to the stub over a real HTTP boundary.
 *
 * Corpus (fixed vectors make the scores deterministic):
 *   doc1 "the cat sat on the mat"   -> exact keyword 'mat' (FTS) + shared
 *                                      'mat' embedding bucket  -> 'both'
 *   doc2 "the dog ran into the park"-> no 'mat' token, but 'into' hashes to the
 *                                      SAME embedding bucket as 'mat' (bucket
 *                                      352)                        -> 'semantic'
 *   doc3 "quantum entanglement..."  -> zero overlap with 'mat'    -> dropped by
 *                                      BIBLOS_MIN_SCORE=0.1
 *
 * Assertions: both strategies contribute (REQ-005 "results from both strategies
 * are merged and ranked by combined score"), ranking is descending, and the
 * unrelated document is filtered out by the min-score threshold.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { connectAgent, parseOk, spawnBiblos, startEmbeddingStub } from './harness.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('E2E — hybrid search over built server (REQ-memory-search)', () => {
  it('returns semantic + keyword hits, ranked by merged score, with fixed mock vectors', { timeout: 30_000 }, async () => {
    const stub = await startEmbeddingStub();
    cleanups.push(() => stub.close());

    // minScore 0.1: zero-overlap (unrelated) docs are dropped, semantic-only
    // hits (merged ~0.22) and keyword hits (merged > 0.35) survive.
    const server = await spawnBiblos({ routerUrl: stub.url, minScore: 0.1 });
    cleanups.push(() => server.remove());

    const agent = await connectAgent(server.url, 'e2e-search');
    cleanups.push(() => agent.close());

    const doc1 = parseOk(
      await agent.client.callTool({
        name: 'save_document',
        arguments: { content: 'the cat sat on the mat', author: 'e2e', project: 'search-fixture' },
      }),
    ) as { id: string };
    const doc2 = parseOk(
      await agent.client.callTool({
        name: 'save_document',
        arguments: { content: 'the dog ran into the park', author: 'e2e', project: 'search-fixture' },
      }),
    ) as { id: string };
    const doc3 = parseOk(
      await agent.client.callTool({
        name: 'save_document',
        arguments: { content: 'quantum entanglement teleportation notes', author: 'e2e', project: 'search-fixture' },
      }),
    ) as { id: string };

    const result = parseOk(
      await agent.client.callTool({
        name: 'search_documents',
        arguments: { query: 'mat', limit: 10, fusion_weight: 0.5 },
      }),
    ) as {
      query: string;
      count: number;
      hits: Array<{ document: { id: string; content: string }; score: number; matchedBy: string }>;
    };

    expect(result.query).toBe('mat');
    expect(result.count).toBe(2); // doc1 (both) + doc2 (semantic); doc3 filtered out

    const byId = new Map(result.hits.map((hit) => [hit.document.id, hit]));

    // Keyword hit: FTS5 matched the exact term AND the vector overlapped.
    expect(byId.get(doc1.id)?.matchedBy).toBe('both');
    expect(byId.get(doc1.id)?.document.content).toBe('the cat sat on the mat');

    // Semantic hit: no keyword match, but a shared embedding bucket (fixed vectors).
    expect(byId.get(doc2.id)?.matchedBy).toBe('semantic');
    expect(byId.get(doc2.id)?.document.content).toBe('the dog ran into the park');

    // Unrelated document: merged score 0 < minScore 0.1 -> absent.
    expect(byId.has(doc3.id)).toBe(false);

    // Ranked by merged score, descending (REQ-005).
    const scores = result.hits.map((hit) => hit.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(result.hits[0]?.document.id).toBe(doc1.id);
    expect((result.hits[0]?.score ?? 0)).toBeGreaterThan((result.hits[1]?.score ?? 0));
  });
});
