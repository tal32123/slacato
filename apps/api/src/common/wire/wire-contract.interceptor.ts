import { BadRequestException, Injectable, InternalServerErrorException, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import { WIRE_CONTRACT_METADATA, type RequestContract, type RequestPart, type WireContract } from './wire-contract.metadata.js';

interface HttpRequestData {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

/** Globally enforces explicit request and response wire contracts for every controller handler. */
@Injectable()
export class WireContractInterceptor implements NestInterceptor<unknown, unknown> {
  public constructor(private readonly reflector: Reflector) {}

  public intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    const contract = this.reflector.get<WireContract>(WIRE_CONTRACT_METADATA, context.getHandler());
    const request = context.switchToHttp().getRequest<HttpRequestData>();

    for (const part of ['body', 'query', 'params'] as const) this.validateRequestPart(part, request[part], contract?.request[part]);

    return next.handle().pipe(map((payload) => {
      if (!contract?.response) {
        throw new InternalServerErrorException({ code: 'WIRE_SCHEMA_REQUIRED', message: 'Controller response schema is required' });
      }
      const result = contract.response.safeParse(payload);
      if (result.success) return result.data;
      throw new InternalServerErrorException({ code: 'INVALID_RESPONSE', message: 'Response validation failed' });
    }));
  }

  private validateRequestPart(part: RequestPart, value: unknown, declaration: RequestContract | undefined): void {
    if (!hasValues(value)) return;
    if (!declaration) {
      throw new BadRequestException({ code: 'WIRE_SCHEMA_REQUIRED', message: `Controller ${part} schema is required` });
    }
    if (declaration === 'class-dto') return;
    const result = declaration.safeParse(value);
    if (result.success) return;
    throw new BadRequestException({
      code: 'INVALID_REQUEST',
      message: 'Request validation failed',
      issues: result.error.issues.map(({ path, code }) => ({ path, code }))
    });
  }
}

function hasValues(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'object') return true;
  return Object.keys(value).length > 0;
}
