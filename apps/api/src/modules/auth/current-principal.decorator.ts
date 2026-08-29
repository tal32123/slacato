import { createParamDecorator, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedPrincipal, PrincipalAwareRequest } from './contracts.js';

/** Supplies the principal installed by the security guard or rejects a missing installation. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPrincipal => {
    const principal = context.switchToHttp().getRequest<PrincipalAwareRequest>().auth;
    if (principal === undefined) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Authentication is required'
      });
    }
    return principal;
  }
);
