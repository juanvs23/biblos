/**
 * Agent registry domain service tests (design: tests/registry.test.ts, tasks 6.3).
 * Runs against a real temp-file SQLite store — no network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openStore, type Store } from '../src/db/store.js';
import { AgentRegistryService } from '../src/domain/registry.js';

describe('AgentRegistryService', () => {
  let dir: string;
  let store: Store;
  let registry: AgentRegistryService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'biblos-registry-'));
    store = openStore(join(dir, 'test.db'));
    registry = new AgentRegistryService(store);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers an agent with a unique identity and created_at (REQ-registry-register)', () => {
    const agent = registry.register({ name: 'alice', type: 'orchestrator', capabilities: ['memory', 'bus'] });

    expect(agent.name).toBe('alice');
    expect(agent.type).toBe('orchestrator');
    expect(agent.capabilities).toEqual(['memory', 'bus']);
    expect(agent.createdAt).toBeTruthy();
    expect(registry.get('alice')).toEqual(agent); // persisted, read back identically
  });

  it('rejects a duplicate name and leaves the existing identity unchanged (REQ-registry-register)', () => {
    const first = registry.register({ name: 'alice', type: 'orchestrator', capabilities: ['memory'] });

    expect(() => registry.register({ name: 'alice', type: 'worker', capabilities: ['bus'] })).toThrowError(
      expect.objectContaining({ code: 'identity_error' }),
    );
    expect(registry.get('alice')).toEqual(first); // original type/capabilities intact
  });

  it('rejects registration without a type or capabilities (REQ-registry-register)', () => {
    expect(() => registry.register({ name: 'alice', type: '', capabilities: ['x'] })).toThrowError(
      expect.objectContaining({ code: 'invalid_document' }),
    );
    expect(() => registry.register({ name: 'alice', type: 'agent', capabilities: [] })).toThrowError(
      expect.objectContaining({ code: 'invalid_document' }),
    );
    expect(() => registry.register({ name: '', type: 'agent', capabilities: ['x'] })).toThrowError(
      expect.objectContaining({ code: 'invalid_document' }),
    );
    expect(store.listAgents()).toHaveLength(0);
  });

  it('normalizes whitespace in names, types, and capabilities', () => {
    const agent = registry.register({ name: '  alice  ', type: '  agent  ', capabilities: [' memory ', 'bus'] });
    expect(agent.name).toBe('alice');
    expect(agent.type).toBe('agent');
    expect(agent.capabilities).toEqual(['memory', 'bus']);
  });

  it('get on an unknown agent throws not-found', () => {
    expect(() => registry.get('nobody')).toThrowError(expect.objectContaining({ code: 'not_found' }));
  });

  it('lists registered agents', () => {
    registry.register({ name: 'bob', type: 'worker', capabilities: ['bus'] });
    registry.register({ name: 'alice', type: 'orchestrator', capabilities: ['memory'] });

    expect(registry.list().map((a) => a.name)).toEqual(['alice', 'bob']);
  });

  it('assertRegistered throws an identity error for unknown agents (REQ-registry)', () => {
    expect(() => registry.assertRegistered('alice')).toThrowError(
      expect.objectContaining({ code: 'identity_error', message: expect.stringContaining('not registered') }),
    );

    registry.register({ name: 'alice', type: 'agent', capabilities: ['x'] });
    expect(() => registry.assertRegistered('alice')).not.toThrow();
  });
});
