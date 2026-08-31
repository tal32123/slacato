import type { ResetSandbox } from '@slacato/core';

export type SandboxModuleOptions = Readonly<{
  /** Previews and performs the reset, already bound to the designated sandbox database. */
  resetSandbox: ResetSandbox;
}>;

export const RESET_SANDBOX = Symbol('RESET_SANDBOX');
