import {
  Injectable,
  type NestMiddleware,
  PayloadTooLargeException,
  UnsupportedMediaTypeException
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const jsonContentType = /^application\/json(?:;|$)/i;
const MAX_BODY_BYTES = 1_048_576;

/** Enforces generic HTTP safety rules before route-specific Zod validation. */
@Injectable()
export class ApiWireBoundaryMiddleware implements NestMiddleware {
  /** Rejects oversized or unsupported request bodies before continuing the middleware chain. */
  public use(request: Request, _response: Response, next: NextFunction): void {
    const declaredLength = Number(request.headers['content-length'] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      throw new PayloadTooLargeException({
        code: 'REQUEST_TOO_LARGE',
        message: 'Request body exceeds the 1 MiB limit'
      });
    }
    if (
      ['POST', 'PUT', 'PATCH'].includes(request.method) &&
      !jsonContentType.test(request.headers['content-type'] ?? '')
    ) {
      throw new UnsupportedMediaTypeException({
        code: 'UNSUPPORTED_CONTENT_TYPE',
        message: 'Only application/json is supported'
      });
    }
    next();
  }
}
