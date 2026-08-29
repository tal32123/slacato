import type { RunEvent, RunStatus } from '../runs/contracts.js';

/** Stable classifications callers may safely expose or map to transport errors. */
export type AppErrorCode =
  | 'AUTHORIZATION_DENIED'
  | 'CONFLICT'
  | 'INVALID_RUN_TRANSITION'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED';

type AppErrorDetails = Readonly<Record<string, boolean | number | string>>;

/** Provides stable, non-sensitive classifications and safe messages for domain failures. */
export abstract class AppError extends Error {
  public readonly details: AppErrorDetails;
  public readonly safeMessage: string;

  /** Captures the stable classification, safe message, and diagnostic details for a domain failure. */
  protected constructor(
    public readonly code: AppErrorCode,
    message: string,
    safeMessage: string,
    details: AppErrorDetails = {}
  ) {
    super(message);
    this.name = this.constructor.name;
    this.safeMessage = safeMessage;
    this.details = details;
  }
}

/** Signals an invalid workflow state/event pair before it reaches persistence. */
export class InvalidRunTransitionError extends AppError {
  /** Describes the rejected event and the run status that made it invalid. */
  public constructor(status: RunStatus, event: RunEvent) {
    super(
      'INVALID_RUN_TRANSITION',
      `Cannot apply event "${event}" while run is "${status}"`,
      'The requested workflow action is not available for this run.',
      { event, status }
    );
  }
}

/** Signals a domain value that did not satisfy its immutable contract. */
export class DomainValidationError extends AppError {
  /** Creates a validation failure with a safe public message and optional diagnostics. */
  public constructor(message: string, details: AppErrorDetails = {}) {
    super('VALIDATION_FAILED', message, 'The submitted data is invalid.', details);
  }
}

/** Signals an attempted operation outside the caller's effective access scope. */
export class AuthorizationDeniedError extends AppError {
  /** Creates an opaque access failure with optional non-sensitive diagnostics. */
  public constructor(message = 'Access denied', details: AppErrorDetails = {}) {
    super('AUTHORIZATION_DENIED', message, 'You are not allowed to perform this action.', details);
  }
}

/** Signals a requested domain resource that is absent from the authorized scope. */
export class DomainNotFoundError extends AppError {
  /** Creates an absence failure for a resource within the authorized scope. */
  public constructor(resource: string, details: AppErrorDetails = {}) {
    super(
      'NOT_FOUND',
      `${resource} was not found`,
      'The requested resource was not found.',
      details
    );
  }
}

/** Signals a domain operation that conflicts with the currently persisted version. */
export class DomainConflictError extends AppError {
  /** Creates a state-conflict failure with optional non-sensitive diagnostics. */
  public constructor(message: string, details: AppErrorDetails = {}) {
    super('CONFLICT', message, 'The requested change conflicts with the current state.', details);
  }
}
