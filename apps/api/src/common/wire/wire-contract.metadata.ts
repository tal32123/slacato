import type { ZodType } from 'zod';

export const WIRE_CONTRACT_METADATA = Symbol('slacato:wire-contract');

export type RequestPart = 'body' | 'query' | 'params';
export type RequestContract = ZodType<unknown> | 'class-dto';

export interface WireContract {
  readonly request: Partial<Record<RequestPart, RequestContract>>;
  readonly response?: ZodType<unknown>;
}
