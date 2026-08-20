# Tasks: multi-agent-client-setup

## Review Workload Forecast

- **Estimated total changed lines**: ~800
- **Risk**: High — exceeds 400-line review budget
- **Chain strategy**: stacked-to-main
- **Delivery**: 3 chained PRs (see SDD delivery_strategy: chained PRs)

---

## Phase 1: Foundation (T001-T007) — Work Unit 1 ✅ COMPLETE

- [x] T001: Create directory structure (`tools/`, `tools/lib/`, `tools/adapters/`)
- [x] T002: Dependency checker (`lib/core.sh` — `check_deps`)
- [x] T003: Logging helpers (`lib/core.sh` — `log_info`, `log_error`, `generate_key`)
- [x] T004: Backup/restore library (`lib/backup.sh` — `create_backup`, `restore_backup`, `validate_backup`)
- [x] T005: TUI helpers (`lib/tui.sh` — `prompt_default`, `prompt_choice`, `prompt_confirm`)
- [x] T006: Main script flow (`setup-biblos.sh` — orchestration, flag parsing, trap handlers)
- [x] T007: Agent registration (`lib/core.sh` — `register_agent` function)

## Phase 2: Adapters + Smoke Tests (T008-T015) — Work Unit 2 ✅ COMPLETE

- [x] T008: OpenCode adapter — config write (`adapters/opencode.sh`)
- [x] T009: OpenCode adapter — smoke test + adapter interface (`adapters/opencode.sh`)
- [x] T010: OpenClaw adapter — config write (`adapters/openclaw.sh`)
- [x] T011: OpenClaw adapter — smoke test + secret store (`adapters/openclaw.sh`)
- [x] T012: Claude Code adapter — CLI detection + graceful skip (`adapters/claude-code.sh`)
- [x] T013: Claude Code adapter — smoke test + CLI invocation (`adapters/claude-code.sh`)
- [x] T014: Adapter registry and dispatch (`setup-biblos.sh` — `get_adapter_file()`)
- [x] T015: End-to-end smoke test wiring (integration of adapter flow, rollback, summary)

## Phase 3: Testing & Polish (T016-T020) — Work Unit 3 ✅ COMPLETE

- [x] T016: Unit test — OpenCode adapter (`tools/tests/unit_opencode.sh`)
- [x] T017: Unit test — OpenClaw adapter (`tools/tests/unit_openclaw.sh`)
- [x] T018: Unit test — Claude Code adapter (`tools/tests/unit_claude_code.sh`)
- [x] T019: Integration tests (full flow, rollback, edge cases) (`tools/tests/integration.sh`)
- [x] T020: Edge cases and NFR validation (`tools/tests/edge_cases.sh`)
