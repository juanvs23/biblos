/**
 * Agent bus domain service (design: src/domain/bus.ts, tasks 6.2).
 *
 * Persistent inter-agent request queue with an explicit lifecycle
 * (pendiente -> en-proceso -> completada | fallida). Identity is enforced at
 * the domain boundary (REQ-bus-send/poll/respond):
 *
 * - send: caller AND recipient must be registered; nothing is enqueued otherwise.
 * - poll: claims the oldest pendiente request addressed to the caller; requests
 *   addressed to other agents are never visible (foreign claim -> empty result,
 *   state untouched, per design).
 * - respond: the caller MUST be the request's registered recipient; state must
 *   be en-proceso; otherwise the call fails and the state is unchanged.
 * - status: read-only; does not require registration (design open question,
 *   default: auth at the transport boundary only).
 */
import { randomUUID } from 'node:crypto';

import type { Store } from '../db/store.js';
import { DomainError } from './errors.js';
import type { AgentRegistryService } from './registry.js';
import type { BusRequest } from './types.js';

export type RespondState = 'completada' | 'fallida';

export interface SendInput {
  recipient: string;
  payload?: unknown;
}

export interface RespondInput {
  id: string;
  state: RespondState;
  result?: unknown;
}

export class AgentBusService {
  constructor(
    private readonly store: Store,
    private readonly registry: AgentRegistryService,
  ) {}

  /** Enqueue a request in state `pendiente`; unregistered sender or recipient is rejected (REQ-bus-send). */
  send(caller: string, input: SendInput): BusRequest {
    this.registry.assertRegistered(caller); // identity error: sender must be registered
    const recipient = input.recipient.trim();
    if (recipient.length === 0) {
      throw new DomainError('invalid_document', 'recipient is required');
    }
    this.registry.assertRegistered(recipient); // identity error: recipient must be registered

    const request: BusRequest = {
      id: randomUUID(),
      sender: caller,
      recipient,
      payload: input.payload ?? null,
      state: 'pendiente',
      createdAt: new Date().toISOString(),
    };
    this.store.enqueue(request);
    return this.status(request.id);
  }

  /**
   * Claim the oldest pendiente request addressed to the caller (REQ-bus-poll).
   * Requests for other agents are not candidates: a foreign claim yields an
   * empty result and the pending request stays untouched.
   */
  poll(caller: string): BusRequest | null {
    this.registry.assertRegistered(caller); // identity error: caller must be registered
    return this.store.claim(caller);
  }

  /** Set a claimed request to completada/fallida; verifies the caller IS the recipient (REQ-bus-respond). */
  respond(caller: string, input: RespondInput): BusRequest {
    this.registry.assertRegistered(caller); // identity error: caller must be registered
    const current = this.store.status(input.id);
    if (!current) {
      throw new DomainError('not_found', `request ${input.id} not found`);
    }
    if (current.recipient !== caller) {
      throw new DomainError('identity_error', `request ${input.id} is not addressed to agent ${caller}`);
    }
    if (current.state !== 'en-proceso') {
      throw new DomainError('state_error', `request ${input.id} is in state ${current.state}, expected en-proceso`);
    }

    const updated = this.store.respond(input.id, { state: input.state, result: input.result }, caller);
    if (!updated) {
      throw new DomainError('state_error', `request ${input.id} could not be transitioned to ${input.state}`);
    }
    return this.status(input.id) as BusRequest;
  }

  /** Read-only status lookup (REQ-bus-status). */
  status(id: string): BusRequest {
    const request = this.store.status(id);
    if (!request) {
      throw new DomainError('not_found', `request ${id} not found`);
    }
    return request;
  }
}
