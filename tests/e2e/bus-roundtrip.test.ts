/**
 * E2E — agent bus roundtrip over the REAL built server (task 8.1).
 *
 * Spawns `dist/index.js` (temp DB, temp port) and drives the two-agent
 * lifecycle through the official MCP SDK Client over Streamable HTTP, exactly
 * as OpenClaw/OpenCode would:
 *
 *   1. registration-first rule: unregistered sender is rejected (REQ-registry)
 *   2. request_send  -> pendiente, unique id, sender from header (REQ-bus-send)
 *   3. request_poll  -> oldest pendiente claimed, en-proceso (REQ-bus-poll)
 *   4. nothing pending -> empty claim (REQ-bus-poll)
 *   5. request_respond -> completada/fallida with payload (REQ-bus-respond)
 *   6. request_status -> final state + payload (REQ-bus-status)
 *
 * Plus REQ-017: a second test restarts the server process on the SAME DB file
 * and verifies every request retains its pre-restart state and payload, and
 * that the bus remains fully functional afterwards.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  connectAgent,
  parseError,
  parseOk,
  registerAgent,
  spawnBiblos,
  type SpawnedBiblos,
} from './harness.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('E2E — bus roundtrip over built server (REQ-bus-send/poll/respond/status)', () => {
  it('two agents complete send -> poll -> respond -> status', { timeout: 30_000 }, async () => {
    const server = await spawnBiblos({});
    cleanups.push(() => server.remove());

    const alice = await connectAgent(server.url, 'alice');
    cleanups.push(() => alice.close());
    const bob = await connectAgent(server.url, 'bob');
    cleanups.push(() => bob.close());

    // REQ-registry-register: an unregistered agent cannot use the bus.
    const unregistered = parseError(
      await alice.client.callTool({ name: 'request_send', arguments: { recipient: 'bob', payload: 'hi' } }),
    );
    expect(unregistered.code).toBe('identity_error');

    await registerAgent(alice, 'alice');
    await registerAgent(bob, 'bob');

    // REQ-bus-send: enqueue pendiente with a unique id; sender comes from the header.
    const sent = parseOk(
      await alice.client.callTool({
        name: 'request_send',
        arguments: { recipient: 'bob', payload: { task: 'summarize', topic: 'e2e' } },
      }),
    ) as { id: string; sender: string; recipient: string; state: string; payload: unknown };
    expect(sent.state).toBe('pendiente');
    expect(sent.sender).toBe('alice');
    expect(sent.recipient).toBe('bob');
    expect(sent.payload).toEqual({ task: 'summarize', topic: 'e2e' });
    expect(sent.id.length).toBeGreaterThan(0);

    // REQ-bus-poll: bob claims the oldest pendiente addressed to him -> en-proceso.
    const claimed = parseOk(await bob.client.callTool({ name: 'request_poll', arguments: {} })) as {
      id: string;
      state: string;
      sender: string;
      payload: unknown;
    };
    expect(claimed.id).toBe(sent.id);
    expect(claimed.state).toBe('en-proceso');
    expect(claimed.sender).toBe('alice');
    expect(claimed.payload).toEqual({ task: 'summarize', topic: 'e2e' });

    // REQ-bus-poll "Nothing pending": a second poll yields an empty result.
    const empty = parseOk(await bob.client.callTool({ name: 'request_poll', arguments: {} }));
    expect(empty).toBeNull();

    // REQ-bus-respond: completada with a result payload.
    const done = parseOk(
      await bob.client.callTool({
        name: 'request_respond',
        arguments: { id: sent.id, state: 'completada', result: { summary: 'ok' } },
      }),
    ) as { state: string; result: unknown };
    expect(done.state).toBe('completada');
    expect(done.result).toEqual({ summary: 'ok' });

    // REQ-bus-status: the sender sees the final state and payload.
    const status = parseOk(await alice.client.callTool({ name: 'request_status', arguments: { id: sent.id } })) as {
      state: string;
      result: unknown;
    };
    expect(status.state).toBe('completada');
    expect(status.result).toEqual({ summary: 'ok' });
  });
});

describe('E2E — queue survives a server restart (REQ-bus-status, REQ-core-persistence)', () => {
  it('keeps pendiente/completada states across a fresh process on the same DB', { timeout: 40_000 }, async () => {
    const first = await spawnBiblos({});
    cleanups.push(() => first.remove());

    const alice = await connectAgent(first.url, 'alice');
    cleanups.push(() => alice.close());
    const bob = await connectAgent(first.url, 'bob');
    cleanups.push(() => bob.close());
    await registerAgent(alice, 'alice');
    await registerAgent(bob, 'bob');

    // One request completed, one left pendiente.
    const completed = parseOk(
      await alice.client.callTool({ name: 'request_send', arguments: { recipient: 'bob', payload: 'done task' } }),
    ) as { id: string };
    const pending = parseOk(
      await alice.client.callTool({ name: 'request_send', arguments: { recipient: 'bob', payload: 'open task' } }),
    ) as { id: string };

    const claimed = parseOk(await bob.client.callTool({ name: 'request_poll', arguments: {} })) as { id: string };
    expect(claimed.id).toBe(completed.id); // oldest pendiente first
    const responded = parseOk(
      await bob.client.callTool({
        name: 'request_respond',
        arguments: { id: completed.id, state: 'fallida', result: { error: 'not enough context' } },
      }),
    ) as { state: string };
    expect(responded.state).toBe('fallida');

    // --- restart: kill the process, spawn a NEW one on the SAME DB file ---
    await first.stop();
    const second: SpawnedBiblos = await spawnBiblos({ dbPath: first.dbPath, dir: first.dir });
    cleanups.push(() => second.remove());

    // REQ-bus-status: every request retains its pre-restart state and payload.
    const alice2 = await connectAgent(second.url, 'alice');
    cleanups.push(() => alice2.close());
    const completedAfter = parseOk(
      await alice2.client.callTool({ name: 'request_status', arguments: { id: completed.id } }),
    ) as { state: string; result: unknown };
    expect(completedAfter.state).toBe('fallida');
    expect(completedAfter.result).toEqual({ error: 'not enough context' });

    const pendingAfter = parseOk(
      await alice2.client.callTool({ name: 'request_status', arguments: { id: pending.id } }),
    ) as { state: string };
    expect(pendingAfter.state).toBe('pendiente');

    // The bus is still fully functional: bob claims the surviving pendiente request.
    const bob2 = await connectAgent(second.url, 'bob');
    cleanups.push(() => bob2.close());
    const claimedAfter = parseOk(await bob2.client.callTool({ name: 'request_poll', arguments: {} })) as {
      id: string;
      state: string;
      payload: unknown;
    };
    expect(claimedAfter.id).toBe(pending.id);
    expect(claimedAfter.state).toBe('en-proceso');
    expect(claimedAfter.payload).toBe('open task');
  });
});
