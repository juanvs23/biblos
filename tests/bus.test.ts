/**
 * Agent bus domain service tests (design: tests/bus.test.ts, tasks 6.4).
 * State machine, identity verification, and persistence against a real
 * temp-file SQLite store — no network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openStore, type Store } from '../src/db/store.js';
import { AgentBusService } from '../src/domain/bus.js';
import { AgentRegistryService } from '../src/domain/registry.js';

describe('AgentBusService', () => {
  let dir: string;
  let dbPath: string;
  let store: Store;
  let registry: AgentRegistryService;
  let bus: AgentBusService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'biblos-bus-'));
    dbPath = join(dir, 'test.db');
    store = openStore(dbPath);
    registry = new AgentRegistryService(store);
    bus = new AgentBusService(store, registry);
    registry.register({ name: 'alice', type: 'orchestrator', capabilities: ['bus'] });
    registry.register({ name: 'bob', type: 'worker', capabilities: ['bus'] });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends to a registered agent, enqueuing in pendiente with a unique id (REQ-bus-send)', () => {
    const request = bus.send('alice', { recipient: 'bob', payload: { task: 'ping' } });

    expect(request.id).toBeTruthy();
    expect(request.sender).toBe('alice');
    expect(request.recipient).toBe('bob');
    expect(request.state).toBe('pendiente');
    expect(request.payload).toEqual({ task: 'ping' });
    expect(bus.status(request.id).id).toBe(request.id);
  });

  it('rejects sending to an unregistered recipient and enqueues nothing (REQ-bus-send)', () => {
    expect(() => bus.send('alice', { recipient: 'mallory', payload: 1 })).toThrowError(
      expect.objectContaining({ code: 'identity_error', message: expect.stringContaining('mallory') }),
    );
    expect(store.status('anything')).toBeNull();
  });

  it('rejects sending from an unregistered caller (REQ-registry unregistered bus use)', () => {
    expect(() => bus.send('mallory', { recipient: 'bob', payload: 1 })).toThrowError(
      expect.objectContaining({ code: 'identity_error' }),
    );
  });

  it('poll claims the oldest pendiente request addressed to the caller (REQ-bus-poll)', async () => {
    const first = bus.send('alice', { recipient: 'bob', payload: 'one' });
    // Space the sends so created_at differs: the queue orders by (created_at, id),
    // and a same-millisecond tie would fall back to arbitrary UUID ordering.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = bus.send('alice', { recipient: 'bob', payload: 'two' });

    const claimed = bus.poll('bob');
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.state).toBe('en-proceso');
    expect(bus.status(first.id).state).toBe('en-proceso');

    expect(bus.poll('bob')?.id).toBe(second.id);
    expect(bus.poll('bob')).toBeNull();
  });

  it('rejects a foreign poll: another agent sees nothing and the state stays pendiente (REQ-bus-poll)', () => {
    bus.send('bob', { recipient: 'alice', payload: 'for alice' });

    // bob is registered but is not the recipient: the claim is rejected with an
    // empty result and alice's request is untouched.
    expect(bus.poll('bob')).toBeNull();
    const after = bus.poll('alice');
    expect(after?.payload).toBe('for alice');
    expect(after?.state).toBe('en-proceso');
  });

  it('poll from an unregistered caller is an identity error', () => {
    expect(() => bus.poll('mallory')).toThrowError(expect.objectContaining({ code: 'identity_error' }));
  });

  it('respond completes a claimed request with a result payload (REQ-bus-respond)', () => {
    const request = bus.send('alice', { recipient: 'bob', payload: 'do it' });
    bus.poll('bob');

    const completed = bus.respond('bob', { id: request.id, state: 'completada', result: { ok: true } });

    expect(completed.state).toBe('completada');
    expect(completed.result).toEqual({ ok: true });
    expect(bus.status(request.id).state).toBe('completada');
  });

  it('respond marks a request as fallida with an error payload', () => {
    const request = bus.send('alice', { recipient: 'bob', payload: 'do it' });
    bus.poll('bob');

    const failed = bus.respond('bob', { id: request.id, state: 'fallida', result: { error: 'nope' } });

    expect(failed.state).toBe('fallida');
    expect(failed.result).toEqual({ error: 'nope' });
  });

  it('rejects a respond from a non-recipient agent and keeps the state unchanged (REQ-bus-respond)', () => {
    const request = bus.send('bob', { recipient: 'alice', payload: 'for alice' });
    bus.poll('alice');

    expect(() => bus.respond('bob', { id: request.id, state: 'completada', result: {} })).toThrowError(
      expect.objectContaining({ code: 'identity_error' }),
    );
    expect(bus.status(request.id).state).toBe('en-proceso');
  });

  it('rejects responding from the wrong state (REQ-bus-respond)', () => {
    const request = bus.send('alice', { recipient: 'bob', payload: 1 });
    // still pendiente: never claimed
    expect(() => bus.respond('bob', { id: request.id, state: 'completada', result: {} })).toThrowError(
      expect.objectContaining({ code: 'state_error' }),
    );

    bus.poll('bob');
    bus.respond('bob', { id: request.id, state: 'completada', result: { ok: true } });
    // already completada: second respond fails
    expect(() => bus.respond('bob', { id: request.id, state: 'completada', result: {} })).toThrowError(
      expect.objectContaining({ code: 'state_error' }),
    );
    expect(bus.status(request.id).result).toEqual({ ok: true });
  });

  it('rejects responding to an unknown request id (REQ-bus-status)', () => {
    expect(() => bus.respond('bob', { id: 'missing', state: 'completada', result: {} })).toThrowError(
      expect.objectContaining({ code: 'not_found' }),
    );
  });

  it('status returns the current state and payload (REQ-bus-status)', () => {
    const request = bus.send('alice', { recipient: 'bob', payload: { hello: 'world' } });
    expect(bus.status(request.id)).toMatchObject({ state: 'pendiente', payload: { hello: 'world' } });
  });

  it('status on an unknown id throws not-found (REQ-bus-status)', () => {
    expect(() => bus.status('missing')).toThrowError(expect.objectContaining({ code: 'not_found' }));
  });

  it('persists requests and their state across a reopen (REQ-bus-status restart)', () => {
    const request = bus.send('alice', { recipient: 'bob', payload: 'persist me' });

    store.close();
    store = openStore(dbPath);
    registry = new AgentRegistryService(store);
    bus = new AgentBusService(store, registry);

    const after = bus.status(request.id);
    expect(after.state).toBe('pendiente');
    expect(after.payload).toBe('persist me');

    const claimed = bus.poll('bob');
    expect(claimed?.id).toBe(request.id);
    expect(bus.status(request.id).state).toBe('en-proceso');
  });
});
