import { Body, Param, Query } from '@nestjs/common';
import { sseEnvelopeSchema, type SseEnvelope } from '@slacato/contracts';
import type { ZodType } from 'zod';
import { WIRE_CONTRACT_METADATA, type RequestContract, type RequestPart, type WireContract } from './wire-contract.metadata.js';

/** Applies strict Zod validation to a JSON request body at the controller boundary. */
export const ZodBody = <TOutput>(schema: ZodType<TOutput>): ParameterDecorator => requestPart('body', schema, Body());

/** Applies strict Zod validation to route query data at the controller boundary. */
export const ZodQuery = <TOutput>(schema: ZodType<TOutput>): ParameterDecorator => requestPart('query', schema, Query());

/** Applies strict Zod validation to route parameters at the controller boundary. */
export const ZodParam = <TOutput>(schema: ZodType<TOutput>): ParameterDecorator => requestPart('params', schema, Param());

/** Explicitly opts a legacy class DTO body into the strict global ValidationPipe fallback. */
export const ClassDtoBody = (): ParameterDecorator => requestPart('body', 'class-dto', Body());

/** Applies strict Zod validation to a controller's serialized response. */
export const ZodResponse = <TOutput>(schema: ZodType<TOutput>): MethodDecorator => (target, propertyKey, descriptor) => {
  const handler = descriptor.value;
  if (!handler) throw new TypeError('ZodResponse requires a method descriptor');
  const existing = Reflect.getMetadata(WIRE_CONTRACT_METADATA, handler) as WireContract | undefined;
  Reflect.defineMetadata(WIRE_CONTRACT_METADATA, { request: existing?.request ?? {}, response: schema } satisfies WireContract, handler);
  return descriptor;
};

/** Validates a generic SSE envelope before an SSE transport serializes it. */
export const validateSseEnvelope = (input: unknown): SseEnvelope => sseEnvelopeSchema.parse(input);

/** Creates the only transport-facing SSE publisher primitive; every envelope validates before emit. */
export const createSsePublisher = <TResult>(emit: (envelope: SseEnvelope) => TResult) => (input: unknown): TResult => emit(validateSseEnvelope(input));

function requestPart(part: RequestPart, declaration: RequestContract, nestDecorator: ParameterDecorator): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    if (!propertyKey) throw new TypeError('Wire request schemas require a controller method');
    const handler = (target as Record<string | symbol, unknown>)[propertyKey];
    if (typeof handler !== 'function') throw new TypeError('Wire request schemas require a controller method');
    const existing = Reflect.getMetadata(WIRE_CONTRACT_METADATA, handler) as WireContract | undefined;
    const request = { ...existing?.request, [part]: declaration };
    const nextContract: WireContract = existing?.response ? { request, response: existing.response } : { request };
    Reflect.defineMetadata(WIRE_CONTRACT_METADATA, nextContract, handler);
    nestDecorator(target, propertyKey, parameterIndex);
  };
}
