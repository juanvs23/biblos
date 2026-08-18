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

## Phase 2: Adapters + Smoke Tests (T008-T015) — Work Unit 2

- [ ] T008: OpenCode adapter — config write (`adapters/opencode.sh`)
- [ ] T009: OpenCode adapter — smoke test + adapter interface (`adapters/opencode.sh`)
- [ ] T010: OpenClaw adapter — config write (`adapters/openclaw.sh`)
- [ ] T011: OpenClaw adapter — smoke test + secret store (`adapters/openclaw.sh`)
- [ ] T012: Claude Code adapter — CLI detection + graceful skip (`adapters/claude-code.sh`)
- [ ] T013: Claude Code adapter — smoke test + CLI invocation (`adapters/claude-code.sh`)
- [ ] T014: Adapter registry and dispatch (`setup-biblos.sh`)
- [ ] T015: End-to-end smoke test wiring (integration of adapter flow)

## Phase 3: Testing & Polish (T016-T020) — Work Unit 3

- [ ] T016: Unit test — OpenCode adapter
- [ ] T017: Unit test — OpenClaw adapter
- [ ] T018: Unit test — Claude Code adapter
- [ ] T019: Integration tests (full flow, rollback, edge cases)
- [ ] T020: Edge cases and NFR validation
