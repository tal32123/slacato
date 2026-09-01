import type { DealQueryRepository, OpaqueDenialRecorder } from '@slacato/core';

/** Injection token for the deal query module options. */
export const DEALS_OPTIONS = Symbol('DEALS_OPTIONS');

/** Configures the deals module with its query repository and denial audit sink. */
export type DealsModuleOptions = Readonly<{
  repository: DealQueryRepository;
  denials: OpaqueDenialRecorder;
}>;
