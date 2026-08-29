import { AuthorizationDeniedError } from '../../domain/shared/errors.js';

/** A single opaque denial prevents citation existence, source, and staleness disclosure. */
export function opaqueCitationDenial(): AuthorizationDeniedError {
  return new AuthorizationDeniedError();
}
