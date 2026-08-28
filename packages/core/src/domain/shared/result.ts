import type { AppError } from './errors.js';

/** Explicit success/failure return shape for domain operations that do not throw. */
export type Result<Value, Failure extends AppError = AppError> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Failure };
