# Biblos Setup Tool — Test Suite

Zero-dependency bash test suite for `tools/setup-biblos.sh` and its adapters.
Implements SDD Work Unit 3 (T016–T020) of the `multi-agent-client-setup` change.

## Requirements

- `bash` >= 4, `jq`, `openssl`, `curl` (same set the tool itself requires)
- `python3` — optional, only used by the mock HTTP server. When missing, all
  mock-server-dependent tests skip cleanly with a `SKIP` note.

Tests never touch a real configuration: every file-based test runs inside an
isolated `$HOME` sandbox under `/tmp`, and fake `claude`/`openclaw` stubs
replace the real CLIs.

## Usage

```bash
cd tools/tests
./run-tests.sh              # full suite
./run-tests.sh unit         # unit_*.sh files only
./run-tests.sh integration  # integration.sh only
./run-tests.sh edge         # edge_cases.sh only
```

Exit code is `0` when every test passes, `1` otherwise.

## Layout

| File | Task | What it covers |
|------|------|----------------|
| `run-tests.sh` | harness | Executes each test file, aggregates pass/fail counts |
| `helpers.sh` | — | Assertions, `t()` runner, `$HOME` sandbox, mock server, fake CLI stubs |
| `mock_server.py` | — | Mock MCP HTTP server; behaviour driven by URL path (`/ok`, `/unauthorized`, `/invalid`, …) |
| `unit_opencode.sh` | T016 | OpenCode adapter: config structure, preservation, idempotency, backup/restore, smoke test, no key leakage |
| `unit_openclaw.sh` | T017 | OpenClaw adapter: structure (no inline key), secret-store injection, absent-CLI warning, backup/restore, smoke test |
| `unit_claude_code.sh` | T018 | Claude Code adapter: `claude mcp add` invocation, graceful skip, no-op lifecycle functions, smoke test |
| `integration.sh` | T019 | Full flow (happy path, rollback on 401/unreachable, `--restore`, `--help`, cancel, per-agent E2E, idempotency) |
| `edge_cases.sh` | T020 | Validation helpers, key format, missing deps, backup edge cases, empty/corrupt configs, NFR-001–004 |

## How the mock server works

`start_mock_server` (from `helpers.sh`) launches `mock_server.py` on a free
loopback port and points `MOCK_PORT`/`MOCK_LOG` at it. Every request is logged
as one JSON line to the log file so tests can assert headers and payloads
(e.g. that the smoke test sends `Authorization`, `Origin`, `X-Biblos-Agent`,
and that `register_agent` posts `name`/`type`/`capabilities`).

Path-based behaviours:

| Path | Response |
|------|----------|
| `/ok` | 200 + valid JSON-RPC |
| `/accepted` | 202 + valid JSON-RPC |
| `/unauthorized` | 401 + JSON error |
| `/invalid` | 200 + non-JSON body |
| `/empty` | 200 + empty body |
| anything else | 200 + valid JSON-RPC |

## Security notes

- Every test that generates or writes a key asserts REQ-013: the key appears
  exactly once (the one-time stderr display), never on stdout, and never in
  backup files.
- Sandbox, fake binaries, and mock logs are removed on exit via
  `trap cleanup_all EXIT`.