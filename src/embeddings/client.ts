/**
 * Embedding client - the ONLY llama.cpp boundary seam (design: src/embeddings/client.ts).
 * POSTs to {routerUrl}/v1/embeddings (OpenAI-compatible shape) with the configured
 * model, fast-fails on connect (3s), enforces a total budget (10s), retries once,
 * and L2-normalizes the 768-dimensional response. Fully mockable via fetchImpl.
 */

export type EmbeddingErrorCode =
  | 'embedding_service_unavailable'
  | 'embedding_connect_timeout'
  | 'embedding_timeout'
  | 'embedding_http_status'
  | 'embedding_dimension_mismatch'
  | 'embedding_invalid_response';

export class EmbeddingError extends Error {
  constructor(
    public readonly code: EmbeddingErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export interface EmbeddingClient {
  /** Returns a normalized (L2 unit) embedding vector for the given text. */
  embed(text: string): Promise<number[]>;
}

export interface RouterEmbeddingClientOptions {
  routerUrl: string;
  model: string;
  /** Total per-attempt budget in ms. */
  timeoutMs: number;
  /** Fast-fail budget for the connect phase of an attempt, in ms. */
  connectTimeoutMs: number;
  /** Extra attempts after the first (1 = one retry). */
  retries: number;
  /** Delay between attempts in ms. */
  retryDelayMs?: number;
  /** Expected vector dimension (the router is configured for 768). */
  dimension: number;
  /** Injectable fetch for tests (defaults to globalThis.fetch). */
  fetchImpl?: typeof fetch;
}

export class RouterEmbeddingClient implements EmbeddingClient {
  constructor(private readonly options: RouterEmbeddingClientOptions) {}

  async embed(text: string): Promise<number[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      try {
        return await this.embedOnce(text);
      } catch (err) {
        lastError = err;
        if (attempt < this.options.retries) {
          await sleep(this.options.retryDelayMs ?? 0);
        }
      }
    }
    throw lastError;
  }

  private async embedOnce(text: string): Promise<number[]> {
    const controller = new AbortController();
    const totalTimer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const fetcher = this.options.fetchImpl ?? globalThis.fetch;
      const fetchPromise = fetcher(`${this.options.routerUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.options.model, input: text }),
        signal: controller.signal,
      });

      const response = await Promise.race([
        fetchPromise,
        rejectAfter<Response>(
          this.options.connectTimeoutMs,
          new EmbeddingError('embedding_connect_timeout', 'embedding router connection timed out'),
        ),
      ]);

      if (!response.ok) {
        throw new EmbeddingError(
          'embedding_http_status',
          `embedding router returned HTTP ${response.status}`,
          response.status,
        );
      }

      const body = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
      const embedding = body?.data?.[0]?.embedding;
      if (!Array.isArray(embedding)) {
        throw new EmbeddingError('embedding_invalid_response', 'embedding router response missing data[0].embedding');
      }
      const floats = embedding.map((n) => Number(n));
      if (floats.length !== this.options.dimension) {
        throw new EmbeddingError(
          'embedding_dimension_mismatch',
          `expected ${this.options.dimension}-dimensional embedding, got ${floats.length}`,
        );
      }
      if (floats.some((n) => !Number.isFinite(n))) {
        throw new EmbeddingError('embedding_invalid_response', 'embedding router returned non-finite values');
      }
      return l2Normalize(floats);
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      if (isAbortError(err)) {
        throw new EmbeddingError('embedding_timeout', 'embedding router request timed out');
      }
      throw new EmbeddingError('embedding_service_unavailable', `embedding router unreachable: ${(err as Error).message}`);
    } finally {
      clearTimeout(totalTimer);
    }
  }
}

/** L2-normalize a vector in place into a new array (unit length). */
export function l2Normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector.map(() => 0);
  return vector.map((v) => v / norm);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : (err as Error)?.name === 'AbortError';
}

function rejectAfter<T>(ms: number, error: EmbeddingError): Promise<T> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(error), ms);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
