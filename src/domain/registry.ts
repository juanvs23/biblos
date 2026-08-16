/**
 * Agent registry domain service (design: src/domain/registry.ts, tasks 6.1).
 *
 * Registration is explicit and mandatory: name, type, and capabilities are
 * required, the name is a unique identity, and a created_at timestamp is
 * recorded (REQ-registry-register). Bus services use assertRegistered() so an
 * unregistered agent can never use the bus (REQ-registry).
 */
import type { Store } from '../db/store.js';
import { DomainError } from './errors.js';
import type { AgentRecord } from './types.js';

export interface AgentInput {
  name: string;
  type: string;
  capabilities: string[];
}

export class AgentRegistryService {
  constructor(private readonly store: Store) {}

  /** Register a new agent; duplicate names fail and leave the existing identity unchanged. */
  register(input: AgentInput): AgentRecord {
    const name = input.name.trim();
    const type = input.type.trim();
    if (name.length === 0 || type.length === 0) {
      throw new DomainError('invalid_document', 'agent name and type are required');
    }
    const capabilities = input.capabilities.map((c) => c.trim()).filter((c) => c.length > 0);
    if (capabilities.length === 0) {
      throw new DomainError('invalid_document', 'agent capabilities must be a non-empty array of strings');
    }
    if (this.store.assertAgent(name)) {
      throw new DomainError('identity_error', `agent ${name} is already registered`);
    }

    const agent: AgentRecord = {
      name,
      type,
      capabilities,
      createdAt: new Date().toISOString(),
    };
    this.store.registerAgent(agent);
    return agent;
  }

  get(name: string): AgentRecord {
    const agent = this.store.getAgent(name);
    if (!agent) throw new DomainError('not_found', `agent ${name} not found`);
    return agent;
  }

  list(): AgentRecord[] {
    return this.store.listAgents();
  }

  /** Identity gate: throws an identity error when the agent is not registered. */
  assertRegistered(name: string): void {
    if (!this.store.assertAgent(name)) {
      throw new DomainError('identity_error', `agent ${name} is not registered`);
    }
  }
}
