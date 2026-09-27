/**
 * E2E — keyword search over the REAL built server (REQ-memory-search).
 *
 * Spawns `dist/index.js` (temp DB, temp port) and drives search_documents
 * through the official MCP SDK Client over Streamable HTTP. Search is pure
 * FTS5, so no external service is involved at any point.
 *
 * Corpus: five documents, keyword 'bamboo' in exactly two of them. (A smaller
 * corpus would put the term in more than half the rows, which clamps FTS5's
 * idf to ~0 and collapses all scores toward 1.)
 */
import { afterEach, describe, expect, it } from 'vitest';

import { connectAgent, parseOk, spawnBiblos } from './harness.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

const CORPUS = [
  'bamboo forests shelter red pandas in the mountains', // sparse 'bamboo' mention
  'bamboo bamboo bamboo grows fast in humid valleys', // dense 'bamboo' mention
  'quantum entanglement notes',
  'the server parses HTTP requests quickly',
  'meeting notes about the bus protocol',
];

describe('E2E — FTS5 keyword search over built server (REQ-memory-search)', () => {
  it('ranks keyword hits by FTS relevance with score-only hit fields', { timeout: 30_000 }, async () => {
    const server = await spawnBiblos({});
    cleanups.push(() => server.remove());

    const agent = await connectAgent(server.url, 'e2e-search');
    cleanups.push(() => agent.close());

    const ids: string[] = [];
    for (const content of CORPUS) {
      const saved = parseOk(
        await agent.client.callTool({
          name: 'save_document',
          arguments: { content, author: 'e2e', project: 'search-fixture' },
        }),
      ) as { id: string };
      ids.push(saved.id);
    }

    const result = parseOk(
      await agent.client.callTool({ name: 'search_documents', arguments: { query: 'bamboo', limit: 10 } }),
    ) as { query: string; count: number; hits: Array<{ document: { id: string; content: string }; score: number }> };

    expect(result.query).toBe('bamboo');
    expect(result.count).toBe(2); // only the two bamboo docs match

    // Best FTS match first: the dense mention has the smaller (more negative)
    // bm25 rank. With the kept ftsScore transform the best hit carries the
    // LOWER normalized score — ranking follows bm25 relevance, not the score.
    expect(result.hits[0]?.document.id).toBe(ids[1]);
    expect(result.hits[0]?.document.content).toBe(CORPUS[1]);
    expect(result.hits[1]?.document.id).toBe(ids[0]);
    expect(result.hits[0]!.score).toBeLessThanOrEqual(result.hits[1]!.score);

    for (const hit of result.hits) {
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.score).toBeLessThanOrEqual(1);
      expect('matchedBy' in hit).toBe(false); // field removed from the payload
    }

    // Unrelated documents never surface.
    expect(result.hits.map((hit) => hit.document.id)).not.toContain(ids[2]);
  });

  it('respects BIBLOS_MIN_SCORE: a threshold above every score filters all hits', { timeout: 30_000 }, async () => {
    // ftsScore is always < 1 for a real match, so min_score=1 keeps nothing —
    // proving the threshold is applied end to end.
    const server = await spawnBiblos({ minScore: 1 });
    cleanups.push(() => server.remove());

    const agent = await connectAgent(server.url, 'e2e-search-strict');
    cleanups.push(() => agent.close());

    await agent.client.callTool({
      name: 'save_document',
      arguments: { content: 'bamboo forests shelter red pandas', author: 'e2e' },
    });

    const result = parseOk(
      await agent.client.callTool({ name: 'search_documents', arguments: { query: 'bamboo', limit: 10 } }),
    ) as { count: number };
    expect(result.count).toBe(0);
  });
});
