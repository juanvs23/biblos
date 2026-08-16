# Agent Registry Specification

## Purpose

Explicit, mandatory registration of agent identities. An agent MUST be
registered before it can use bus tools; identity is unique and recorded with a
creation timestamp.

## Requirements

### Requirement: REQ-registry-register — Register Agent

(Proposal REQ-014) The system MUST provide a registration tool that requires
`name`, `type`, and `capabilities`, MUST enforce uniqueness of `name`, MUST
record `created_at`, and MUST reject agents that are not registered when they
use bus tools.

#### Scenario: Register unique agent

- GIVEN a name not already registered
- WHEN the agent calls the registration tool with name, type and capabilities
- THEN the agent is stored with a unique identity and `created_at`

#### Scenario: Duplicate name

- GIVEN a name already registered
- WHEN the agent calls the registration tool again
- THEN the call fails and the existing identity is unchanged

#### Scenario: Missing fields

- GIVEN a registration call without a type or capabilities
- WHEN the agent invokes the registration tool
- THEN the call fails with a validation error

#### Scenario: Unregistered agent uses the bus

- GIVEN an agent that has never registered
- WHEN it calls a bus tool such as `request_send`
- THEN the call fails with an identity error
