import { describe, expect, it, vi } from 'vitest';

import { EmbeddingError, RouterEmbeddingClient } from '../src/embeddings/client.js';

const DIM = 768;

function makeClient(fetchImpl: typeof fetch): { client: RouterEmbeddingClient } {
  return {
    client: new RouterEmbeddingClient({
      routerUrl: 'http://router:8085',
      model: 'nomic-embed-text-v1.5.Q8_0',
      timeoutMs: 10_000,
      connectTimeoutMs: 3_000,
      retries: 1,
      retryDelayMs: 0,
      dimension: DIM,
      fetchImpl,
    }),
  };
}

function embeddingResponse(values: number[]): Response {
  return Response.json({ data: [{ embedding: values }] });
}

function vector(length: number, fill: number): number[] {
  return new Array(length).fill(fill);
}

describe('RouterEmbeddingClient', () => {
  it('posts to the OpenAI-compatible embeddings endpoint and returns a normalized 768-d vector', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string; input: string };
      expect(String(url)).toBe('http://router:8085/v1/embeddings');
      expect(body.model).toBe('nomic-embed-text-v1.5.Q8_0');
      expect(body.input).toBe('hello world');
      return embeddingResponse([3, 4, ...vector(DIM - 2, 0)]);
    });
    const { client } = makeClient(fetchImpl as unknown as typeof fetch);

    const result = await client.embed('hello world');

    expect(result).toHaveLength(DIM);
    expect(result[0]).toBeCloseTo(0.6, 5); // 3/5
    expect(result[1]).toBeCloseTo(0.8, 5); // 4/5
    const norm = Math.sqrt(result.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries once and surfaces a typed error when the router is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { client } = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.embed('x')).rejects.toMatchObject({
      name: 'EmbeddingError',
      code: 'embedding_service_unavailable',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // first attempt + 1 retry
  });

  it('surfaces an HTTP status error with the status code', async () => {
    const fetchImpl = vi.fn(async () => new Response('down', { status: 503 }));
    const { client } = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.embed('x')).rejects.toMatchObject({
      code: 'embedding_http_status',
      status: 503,
    });
  });

  it('rejects vectors that do not match the configured dimension', async () => {
    const fetchImpl = vi.fn(async () => embeddingResponse([1, 2, 3]));
    const { client } = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.embed('x')).rejects.toMatchObject({
      code: 'embedding_dimension_mismatch',
    });
  });

  it('rejects responses missing data[0].embedding', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: 'no model loaded' }));
    const { client } = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.embed('x')).rejects.toMatchObject({
      code: 'embedding_invalid_response',
    });
  });

  it('times out the whole attempt when the total budget elapses', async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const client = new RouterEmbeddingClient({
      routerUrl: 'http://router:8085',
      model: 'm',
      timeoutMs: 20,
      connectTimeoutMs: 10_000,
      retries: 0,
      dimension: DIM,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.embed('x')).rejects.toMatchObject({
      code: 'embedding_timeout',
    });
  });

  it('fast-fails on connect timeout before the total budget', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {})); // never settles
    const client = new RouterEmbeddingClient({
      routerUrl: 'http://router:8085',
      model: 'm',
      timeoutMs: 10_000,
      connectTimeoutMs: 20,
      retries: 0,
      dimension: DIM,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const started = Date.now();
    await expect(client.embed('x')).rejects.toMatchObject({
      code: 'embedding_connect_timeout',
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
