/**
 * Domain records shared across all Biblos domains (design: src/domain/types.ts).
 */

export interface DocumentRecord {
  id: string;
  content: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  project?: string;
  type: string;
}

export interface Relation {
  sourceId: string;
  type: string;
  targetId: string;
}

export type RequestState = 'pendiente' | 'en-proceso' | 'completada' | 'fallida';

export interface BusRequest {
  id: string;
  sender: string;
  recipient: string;
  payload: unknown;
  state: RequestState;
  result?: unknown;
  createdAt: string;
}

export interface AgentRecord {
  name: string;
  type: string;
  capabilities: string[];
  createdAt: string;
}

export interface SearchHit {
  document: DocumentRecord;
  score: number;
}
