# Agent Bus Specification

## Purpose

A persistent inter-agent request queue with an explicit lifecycle
(`pendiente` → `en-proceso` → `completada` | `fallida`). The bus is application
logic running inside the MCP server; it does not use an LLM to route messages.
Only registered agents may send to or claim requests.

## Requirements

### Requirement: REQ-bus-send — Send Request

(Proposal REQ-010) The system MUST provide a `request_send` tool that enqueues a
request with a payload and a recipient, MUST reject recipients not present in
the agent registry, MUST create the item in state `pendiente`, and MUST return a
unique request ID.

#### Scenario: Send to registered agent

- GIVEN a recipient registered in the agent registry
- WHEN the agent calls `request_send` with a payload and that recipient
- THEN a request item is enqueued in state `pendiente` with a unique ID

#### Scenario: Send to unregistered agent

- GIVEN a recipient that is not registered
- WHEN the agent calls `request_send`
- THEN the call fails with a descriptive error and nothing is enqueued

### Requirement: REQ-bus-poll — Poll Request

(Proposal REQ-011) The system MUST provide a `request_poll` tool that claims the
oldest `pendiente` request addressed to the calling agent and MUST transition it
to `en-proceso`. The tool MUST be invoked with the caller's registered identity
and MUST reject any claim whose registered recipient differs from it.

#### Scenario: Poll own request

- GIVEN a `pendiente` request addressed to the calling agent
- WHEN the calling agent invokes `request_poll` with its registered identity
- THEN the request is claimed and its state becomes `en-proceso`

#### Scenario: Poll another agent's request

- GIVEN a request addressed to a different registered agent
- WHEN the calling agent invokes `request_poll`
- THEN the claim is rejected and the request state stays `pendiente`

#### Scenario: Nothing pending

- GIVEN no `pendiente` requests for the calling agent
- WHEN the calling agent invokes `request_poll`
- THEN an empty result is returned with no state change

### Requirement: REQ-bus-respond — Respond to Request

(Proposal REQ-012) The system MUST provide a `request_respond` tool that sets a
claimed request to `completada` with a result payload or to `fallida` with an
error payload. The tool MUST verify that the calling agent's registered identity
equals the request's registered recipient before responding.

#### Scenario: Complete a request

- GIVEN a request in state `en-proceso` claimed by the calling agent
- WHEN the agent invokes `request_respond` with a result payload
- THEN the state becomes `completada` and the payload is stored

#### Scenario: Respond without being the recipient

- GIVEN a request whose registered recipient is a different agent
- WHEN a non-recipient agent invokes `request_respond`
- THEN the call fails and the request state is unchanged

#### Scenario: Respond from a wrong state

- GIVEN a request already in state `completada`
- WHEN the agent invokes `request_respond` again
- THEN the call fails with a state-transition error

### Requirement: REQ-bus-status — Request Status and Persistence

(Proposal REQ-013) The system MUST provide a `request_status` tool that returns
the current state and payload of a request, and the queue MUST persist across
server restarts.

#### Scenario: Status of existing request

- GIVEN a stored request ID
- WHEN the agent calls `request_status`
- THEN the current state and payload are returned

#### Scenario: Queue survives restart

- GIVEN requests in various states, then the server restarts
- WHEN the agent calls `request_status` afterwards
- THEN every request retains its pre-restart state and payload

#### Scenario: Unknown request

- GIVEN a request ID that does not exist
- WHEN the agent calls `request_status`
- THEN the call fails with a not-found error
