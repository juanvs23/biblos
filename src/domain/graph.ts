/**
 * Knowledge graph domain service (design: src/domain/graph.ts, tasks 5.1).
 *
 * - addRelation/removeRelation: typed edges source -> type -> target with
 *   explicit rejection of unknown nodes (REQ-graph-edit).
 * - query: breadth-first traversal from a start node by optional type and
 *   depth (REQ-graph-query).
 * - render: Mermaid syntax by default, Graphviz when requested; valid output
 *   even for an empty graph (REQ-graph-render).
 */
import type { Store } from '../db/store.js';
import { DomainError } from './errors.js';
import type { Relation } from './types.js';

export type GraphFormat = 'mermaid' | 'graphviz';

export interface RelationInput {
  sourceId: string;
  type: string;
  targetId: string;
}

export interface GraphQueryOptions {
  type?: string;
  depth?: number;
}

export interface GraphRenderInput extends GraphQueryOptions {
  /** Omit to render the whole graph. */
  start?: string;
  /** 'mermaid' by default; 'graphviz' optionally. */
  format?: GraphFormat;
}

export interface GraphQueryResult {
  nodes: string[];
  edges: Relation[];
}

export const DEFAULT_GRAPH_DEPTH = 2;

export class GraphService {
  constructor(private readonly store: Store) {}

  /** Persist a typed relation; unknown source/target documents are rejected (REQ-graph-edit). */
  addRelation(input: RelationInput): Relation {
    const relation = validateRelation(input);
    assertNodeExists(this.store, relation.sourceId, 'source');
    assertNodeExists(this.store, relation.targetId, 'target');
    this.store.addRelation(relation); // idempotent when the exact edge already exists
    return relation;
  }

  /** Remove a typed relation; unknown nodes are rejected (REQ-graph-edit). */
  removeRelation(input: RelationInput): void {
    const relation = validateRelation(input);
    assertNodeExists(this.store, relation.sourceId, 'source');
    assertNodeExists(this.store, relation.targetId, 'target');
    this.store.removeRelation(relation); // no-op when the edge is absent
  }

  /** BFS from `start` over outgoing edges, optionally filtered by type (REQ-graph-query). */
  query(start: string, options: GraphQueryOptions = {}): GraphQueryResult {
    if (!this.store.getDocument(start)) {
      throw new DomainError('not_found', `graph start node ${start} not found`);
    }
    const depth = options.depth ?? DEFAULT_GRAPH_DEPTH;
    if (!Number.isInteger(depth) || depth < 0) {
      throw new DomainError('invalid_document', 'graph depth must be a non-negative integer');
    }
    const type = normalizeOptionalType(options.type);
    return this.store.queryGraph(start, type, depth);
  }

  /**
   * Render the subgraph reachable from `start` (or the whole graph when no
   * start is given) as Mermaid (default) or Graphviz (REQ-graph-render).
   */
  render(input: GraphRenderInput = {}): string {
    const format = input.format ?? 'mermaid';
    if (format !== 'mermaid' && format !== 'graphviz') {
      throw new DomainError('invalid_document', `unsupported graph format "${format}" (use mermaid or graphviz)`);
    }

    let nodes: string[];
    let edges: Relation[];
    if (input.start !== undefined) {
      const subgraph = this.query(input.start, { type: input.type, depth: input.depth });
      nodes = subgraph.nodes;
      edges = subgraph.edges;
    } else {
      edges = this.store.listRelations();
      nodes = [];
      const seen = new Set<string>();
      for (const edge of edges) {
        for (const id of [edge.sourceId, edge.targetId]) {
          if (!seen.has(id)) {
            seen.add(id);
            nodes.push(id);
          }
        }
      }
    }

    return format === 'mermaid' ? renderMermaid(nodes, edges) : renderGraphviz(nodes, edges);
  }
}

function validateRelation(input: RelationInput): Relation {
  const sourceId = input.sourceId.trim();
  const type = input.type.trim();
  const targetId = input.targetId.trim();
  if (sourceId.length === 0 || targetId.length === 0) {
    throw new DomainError('invalid_document', 'relation source and target ids are required');
  }
  if (type.length === 0) {
    throw new DomainError('invalid_document', 'relation type is required');
  }
  return { sourceId, type, targetId };
}

function assertNodeExists(store: Store, id: string, role: 'source' | 'target'): void {
  if (!store.getDocument(id)) {
    throw new DomainError('not_found', `relation ${role} document ${id} not found`);
  }
}

function normalizeOptionalType(type: string | undefined): string | undefined {
  const trimmed = type?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Strip newlines and Mermaid-escape quotes inside quoted labels. */
function mermaidLabel(label: string): string {
  return label.replace(/[\r\n]+/g, ' ').replace(/"/g, '#quot;');
}

function renderMermaid(nodes: string[], edges: Relation[]): string {
  const ids = new Map<string, string>();
  nodes.forEach((node, index) => ids.set(node, `n${index}`));
  const lines = ['flowchart LR'];
  for (const node of nodes) {
    lines.push(`  ${ids.get(node)}["${mermaidLabel(node)}"]`);
  }
  for (const edge of edges) {
    lines.push(`  ${ids.get(edge.sourceId)} -->|"${mermaidLabel(edge.type)}"| ${ids.get(edge.targetId)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Escape a DOT quoted string (backslash, quote, control characters). */
function dotLabel(label: string): string {
  return label.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function renderGraphviz(nodes: string[], edges: Relation[]): string {
  const lines = ['digraph G {'];
  for (const node of nodes) {
    lines.push(`  "${dotLabel(node)}";`);
  }
  for (const edge of edges) {
    lines.push(`  "${dotLabel(edge.sourceId)}" -> "${dotLabel(edge.targetId)}" [label="${dotLabel(edge.type)}"];`);
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}
