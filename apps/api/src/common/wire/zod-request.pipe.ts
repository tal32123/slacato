import { BadRequestException, type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/** Validates one controller input and exposes no unvalidated data beyond the wire boundary. */
@Injectable()
export class ZodRequestPipe<TOutput> implements PipeTransform<unknown, TOutput> {
  public constructor(private readonly schema: ZodType<TOutput>) {}

  public transform(value: unknown, _metadata?: ArgumentMetadata): TOutput {
    void _metadata;
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw new BadRequestException({
      code: 'INVALID_REQUEST',
      message: 'Request validation failed',
      issues: result.error.issues.map(({ path, code }) => ({ path, code }))
    });
  }
}
