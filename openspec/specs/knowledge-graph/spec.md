# Knowledge Graph Specification

## Purpose

Typed relations between documents (`source → type → target`) that let agents
navigate connected knowledge. Relations are stored in the single Biblos SQLite
store and manipulated through edit, query, and render tools.

## Requirements

### Requirement: REQ-graph-edit — Edit Relations

(Proposal REQ-007) The system MUST provide a `graph_edit` tool to add and remove
typed relations (`source_id`, `type`, `target_id`) and MUST reject any relation
whose source or target document does not exist.

#### Scenario: Add relation

- GIVEN two existing documents
- WHEN the agent calls `graph_edit` to add a typed relation between them
- THEN the relation is persisted and returned

#### Scenario: Relation to unknown node

- GIVEN a source or target ID that does not exist
- WHEN the agent calls `graph_edit`
- THEN the call fails with a descriptive error and no relation is stored

### Requirement: REQ-graph-query — Query Graph

(Proposal REQ-008) The system MUST provide a `graph_query` tool that traverses
from a start node by relation type and depth and MUST return the reachable nodes
and edges.

#### Scenario: Traverse by depth

- GIVEN a graph and a start node with depth 2
- WHEN the agent calls `graph_query`
- THEN all nodes and edges reachable within depth 2 are returned

#### Scenario: Unknown start node

- GIVEN a start node ID that does not exist
- WHEN the agent calls `graph_query`
- THEN the call fails with a not-found error

### Requirement: REQ-graph-render — Render Graph

(Proposal REQ-009) The system MUST provide a `graph_render` tool that outputs
Mermaid syntax by default and MAY output Graphviz when that format is requested.

#### Scenario: Mermaid default

- GIVEN a non-empty subgraph
- WHEN the agent calls `graph_render` without a format
- THEN valid Mermaid syntax describing the nodes and edges is returned

#### Scenario: Graphviz requested

- GIVEN a request specifying the Graphviz format
- WHEN the agent calls `graph_render`
- THEN Graphviz syntax is returned

#### Scenario: Empty graph

- GIVEN a graph with no nodes
- WHEN the agent calls `graph_render`
- THEN a valid minimal Mermaid graph is returned without error
