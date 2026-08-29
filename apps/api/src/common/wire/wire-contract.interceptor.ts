import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  InternalServerErrorException,
  type NestInterceptor
} from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import {
  type RequestContract,
  type RequestPart,
  WIRE_CONTRACT_METADATA,
  type WireContract
} from './wire-contract.metadata.js';

interface HttpRequestData {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

/** Globally enforces explicit request and response wire contracts for every controller handler. */
@Injectable()
export class WireContractInterceptor implements NestInterceptor<unknown, unknown> {
  /** Creates an interceptor that reads each handler's declared wire contracts. */
  public constructor(private readonly reflector: Reflector) {}

  /** Validates request parts and emitted responses against the handler's wire contracts. */
  public intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    const contract = this.reflector.get<WireContract>(WIRE_CONTRACT_METADATA, context.getHandler());
    const request = context.switchToHttp().getRequest<HttpRequestData>();

    for (const part of ['body', 'query', 'params'] as const)
      this.validateRequestPart(part, request[part], contract?.request[part]);

    if (this.reflector.get<boolean>(SSE_METADATA, context.getHandler())) {
      const schema = contract?.sse;
      if (!schema) {
        throw new InternalServerErrorException({
          code: 'WIRE_SCHEMA_REQUIRED',
          message: 'SSE envelope schema is required'
        });
      }
      return next.handle().pipe(map((emitted) => this.validateSseEnvelope(emitted, schema)));
    }

    return next.handle().pipe(
      map((payload) => {
        if (!contract?.response) {
          throw new InternalServerErrorException({
            code: 'WIRE_SCHEMA_REQUIRED',
            message: 'Controller response schema is required'
          });
        }
        const result = contract.response.safeParse(payload);
        if (result.success) return result.data;
        throw new InternalServerErrorException({
          code: 'INVALID_RESPONSE',
          message: 'Response validation failed'
        });
      })
    );
  }

  /** Validates an emitted SSE message while preserving any surrounding transport fields. */
  private validateSseEnvelope(
    emitted: unknown,
    schema: Exclude<WireContract['sse'], undefined>
  ): unknown {
    const message = asRecord(emitted);
    const envelope = message?.data ?? emitted;
    const result = schema.safeParse(envelope);
    if (!result.success) {
      throw new InternalServerErrorException({
        code: 'INVALID_SSE_ENVELOPE',
        message: 'SSE envelope validation failed'
      });
    }
    return message ? { ...message, data: result.data } : result.data;
  }

  /** Enforces the declared contract for one populated request part. */
  private validateRequestPart(
    part: RequestPart,
    value: unknown,
    declaration: RequestContract | undefined
  ): void {
    if (!hasValues(value)) return;
    if (!declaration) {
      throw new BadRequestException({
        code: 'WIRE_SCHEMA_REQUIRED',
        message: `Controller ${part} schema is required`
      });
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

/** Reports whether a request value contains data that requires validation. */
function hasValues(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'object') return true;
  return Object.keys(value).length > 0;
}

/** Returns an object value as a record when it can carry an SSE data field. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
