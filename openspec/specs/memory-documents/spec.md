# Memory Documents Specification

## Purpose

Documented, keyword-searchable memory for agents. Documents are readable Markdown
with structured metadata, persisted in the single Biblos SQLite store, and
retrieved through CRUD tools plus FTS5 keyword search. Each document is indexed
for keyword search over its content and tags.

## Requirements

### Requirement: REQ-memory-save — Save Document

(Proposal REQ-001) The system MUST provide a `save_document` tool that accepts
Markdown content plus metadata (`author`, `tags`, `project`, `type`) and MUST
persist the content in a `content` field with metadata in structured columns.
The system MUST index the document for FTS5 keyword search and MUST return a
unique document ID.

#### Scenario: Save valid document

- GIVEN valid Markdown content and metadata including author, tags, project and type
- WHEN the agent calls `save_document`
- THEN the document is stored with content and structured metadata columns
- AND the document is indexed for keyword search and a unique ID is returned

#### Scenario: Save invalid document

- GIVEN content that is empty or metadata that is missing required fields
- WHEN the agent calls `save_document`
- THEN the call fails with a descriptive error and no partial row is written

### Requirement: REQ-memory-get — Get Document

(Proposal REQ-002) The system MUST provide a `get_document` tool that returns
the full content and all metadata for a given document ID.

#### Scenario: Get existing document

- GIVEN a stored document ID
- WHEN the agent calls `get_document` with that ID
- THEN the full Markdown content and complete metadata are returned

#### Scenario: Get unknown document

- GIVEN a document ID that does not exist
- WHEN the agent calls `get_document`
- THEN the call fails with a not-found error

### Requirement: REQ-memory-update — Update Document

(Proposal REQ-003) The system MUST provide an `update_document` tool that
updates content and/or metadata, MUST refresh `updated_at`, and MUST keep the
FTS5 keyword index in sync with the current content.

#### Scenario: Update content

- GIVEN an existing document and new Markdown content
- WHEN the agent calls `update_document`
- THEN content and `updated_at` are updated and the FTS5 index reflects the new content

#### Scenario: Update metadata only

- GIVEN an existing document with changed metadata and unchanged content
- WHEN the agent calls `update_document`
- THEN metadata and `updated_at` are updated and the content is unchanged

### Requirement: REQ-memory-delete — Delete Document

(Proposal REQ-004) The system MUST provide a `delete_document` tool that removes
the document and any graph edges referencing it in one atomic operation.

#### Scenario: Delete existing document

- GIVEN a stored document that participates in graph relations
- WHEN the agent calls `delete_document` with its ID
- THEN the document and its graph edges are removed atomically

#### Scenario: Delete unknown document

- GIVEN a document ID that does not exist
- WHEN the agent calls `delete_document`
- THEN the call fails with a not-found error and no data is modified

### Requirement: REQ-memory-search — Keyword Search

(Proposal REQ-005) The system MUST provide a `search_documents` tool that runs
FTS5 keyword search over document content and tags, ranked by bm25 relevance
with the best match first. Each hit MUST carry the document and a normalized
score in (0, 1] derived from the FTS5 bm25 rank (`1/(1+|bm25|)`); hits whose
score is below the configured `BIBLOS_MIN_SCORE` threshold (default 0 keeps all
hits) MUST be dropped, and the `limit` argument MUST cap the number of results
(maximum 100).

#### Scenario: Keyword results ranked best-first

- GIVEN a corpus where several documents contain the query tokens
- WHEN the agent calls `search_documents`
- THEN matching documents are returned best match first, each hit carrying the document and its normalized score

#### Scenario: Threshold drops all hits

- GIVEN a `BIBLOS_MIN_SCORE` threshold above every hit's normalized score
- WHEN the agent calls `search_documents`
- THEN an empty result list is returned

#### Scenario: Limit caps results

- GIVEN more keyword matches than the requested `limit`
- WHEN the agent calls `search_documents` with a limit
- THEN only the first `limit` hits are returned (at most 100)

#### Scenario: Empty corpus

- GIVEN an empty document store
- WHEN the agent calls `search_documents` with any query
- THEN an empty result list is returned without error

### Requirement: REQ-memory-list — List Documents

(Proposal REQ-006) The system MUST provide a `list_documents` tool that filters
documents by `project` and/or `tags` and MUST support pagination.

#### Scenario: Filter and paginate

- GIVEN documents across multiple projects and tags
- WHEN the agent calls `list_documents` with a project and tag filter
- THEN only matching documents are returned for the requested page

#### Scenario: Empty page

- GIVEN a page beyond the last available page
- WHEN the agent calls `list_documents`
- THEN an empty page is returned without error
