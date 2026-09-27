# MCP Server Core Specification

## Purpose

The Biblos MCP server exposes memory, graph, bus, and registry tools over
Streamable HTTP on `127.0.0.1:8199` using `@modelcontextprotocol/sdk@1.30.0`.
It enforces global authentication and Origin validation, serves keyword search
over an FTS5 index, and persists all data in a single SQLite file. The chat
model `qwen35-4b` runs on the llama.cpp router on the VPS but is not used by
the server in v1.

## Requirements

### Requirement: REQ-core-auth — Bearer and Origin Authentication

(Proposal REQ-015) The system MUST require a valid Bearer API key on every
request and MUST validate the `Origin` header, returning 403 for disallowed or
missing origins as mandated by the MCP 2025-11-25 specification.

#### Scenario: Authenticated allowed request

- GIVEN a valid Bearer API key and an allowed Origin
- WHEN a client invokes an MCP tool
- THEN the request is processed normally

#### Scenario: Missing or invalid key

- GIVEN a missing or invalid Bearer API key
- WHEN a client invokes an MCP tool
- THEN the request is rejected with 401

#### Scenario: Disallowed Origin

- GIVEN a valid Bearer API key and a disallowed or missing Origin header
- WHEN a client invokes an MCP tool
- THEN the request is rejected with 403

### Requirement: REQ-core-persistence — Single SQLite Store

(Proposal REQ-017) The system MUST store all documents, relations, requests,
and agent registrations in a single SQLite file at `/opt/biblos/biblos.db`
using better-sqlite3 with an FTS5 keyword index (documents, relations, agents,
and requests tables), and MUST preserve data across restarts.

#### Scenario: Restart preserves data

- GIVEN documents, relations, requests, and registrations in the store
- WHEN the server stops and starts again
- THEN all data is still present and queryable

#### Scenario: Store unavailable

- GIVEN a locked or corrupt database file
- WHEN a tool call needs the store
- THEN the call fails with a surfaced error and no silent data loss

### Requirement: REQ-core-client-docs — Client Integration Documentation

The system MUST document client integration for OpenClaw (Streamable HTTP
transport) and OpenCode (`type: remote`, Bearer header, `oauth: false`). Live
activation of these clients MAY be deferred to a follow-up change without
blocking v1 delivery.

#### Scenario: Documentation present

- GIVEN the delivered v1 server
- WHEN a user follows the integration documentation
- THEN OpenClaw and OpenCode connection instructions are complete and accurate

#### Scenario: Deferred activation

- GIVEN the v1 server delivered
- WHEN client activation is deferred to a follow-up change
- THEN no client connectivity requirement blocks v1 acceptance
