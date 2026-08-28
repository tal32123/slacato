import { CallHandler, Injectable, InternalServerErrorException, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import type { ZodType } from 'zod';

/** Rejects malformed controller results before they leave the server. */
@Injectable()
export class ZodResponseInterceptor<TOutput> implements NestInterceptor<unknown, TOutput> {
  public constructor(private readonly schema: ZodType<TOutput>) {}

  public intercept(_context: ExecutionContext, next: CallHandler<unknown>): Observable<TOutput> {
    return next.handle().pipe(map((payload) => {
      const result = this.schema.safeParse(payload);
      if (result.success) return result.data;
      throw new InternalServerErrorException({ code: 'INVALID_RESPONSE', message: 'Response validation failed' });
    }));
  }
}
