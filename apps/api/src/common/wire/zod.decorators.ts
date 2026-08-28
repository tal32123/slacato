import { Body, Param, Query, UseInterceptors } from '@nestjs/common';
import { sseEnvelopeSchema, type SseEnvelope } from '@slacato/contracts';
import type { ZodType } from 'zod';
import { ZodRequestPipe } from './zod-request.pipe.js';
import { ZodResponseInterceptor } from './zod-response.interceptor.js';

/** Applies strict Zod validation to a JSON request body at the controller boundary. */
export const ZodBody = <TOutput>(schema: ZodType<TOutput>): ParameterDecorator => Body(new ZodRequestPipe(schema));

/** Applies strict Zod validation to route query data at the controller boundary. */
export const ZodQuery = <TOutput>(schema: ZodType<TOutput>): ParameterDecorator => Query(new ZodRequestPipe(schema));

/** Applies strict Zod validation to route parameters at the controller boundary. */
export const ZodParam = <TOutput>(schema: ZodType<TOutput>): ParameterDecorator => Param(new ZodRequestPipe(schema));

/** Applies strict Zod validation to a controller's serialized response. */
export const ZodResponse = <TOutput>(schema: ZodType<TOutput>): MethodDecorator => UseInterceptors(new ZodResponseInterceptor(schema));

/** Validates a generic SSE envelope before an SSE transport serializes it. */
export const validateSseEnvelope = (input: unknown): SseEnvelope => sseEnvelopeSchema.parse(input);
