/**
 * Typed domain errors. Tool layer (later work unit) maps these to MCP
 * `isError:true` results with descriptive text.
 */
export type DomainErrorCode = 'not_found' | 'invalid_document' | 'identity_error' | 'state_error';

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
