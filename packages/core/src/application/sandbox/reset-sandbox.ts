import { AuthorizationDeniedError } from '../../domain/shared/errors.js';
import type { OpaqueDenialRecorder } from '../deals/contracts.js';
import type { SandboxResetReport, SandboxResetStore } from './contracts.js';

/**
 * Previews and performs a sandbox reset for an entitled actor.
 *
 * Whether the reset capability exists at all is an environment decision made once at composition,
 * not here: an API that was not started against a designated sandbox never constructs this command
 * and never routes to it. What is left for the application layer is the second gate - which signed
 * persona may erase a sandbox everyone shares - and making sure a refusal leaves the same opaque
 * audit record every other refused request in this system leaves.
 *
 * Preview is gated exactly as strictly as the reset it previews. The counts describe how much work
 * the sandbox is holding, which is not something an unentitled persona should be able to read, and
 * an authorization rule that only guards the destructive call teaches callers that the safe-looking
 * one is unguarded.
 */
export class ResetSandbox {
  /** Provides the sandbox store and the denial recorder every refusal is written through. */
  public constructor(
    private readonly store: SandboxResetStore,
    private readonly denials: OpaqueDenialRecorder
  ) {}

  /** Reports what a reset would remove, for an actor entitled to remove it. */
  public async preview(input: Readonly<{ actorId: string }>): Promise<SandboxResetReport> {
    await this.authorize(input.actorId);
    return this.store.preview();
  }

  /**
   * Erases the sandbox on behalf of an entitled actor.
   *
   * Pressing this twice is not an error. The second call finds nothing to remove and reports zeroes,
   * because the operation is defined as "leave no run-scoped record behind" rather than as a diff.
   */
  public async execute(input: Readonly<{ actorId: string }>): Promise<SandboxResetReport> {
    await this.authorize(input.actorId);
    return this.store.erase({ actorId: input.actorId });
  }

  /** Refuses an actor without standing, recording the refusal without describing the sandbox. */
  private async authorize(actorId: string): Promise<void> {
    if (await this.store.mayReset(actorId)) return;
    await this.denials.recordOpaqueDenial({ actorId, reason: 'forbidden' });
    throw new AuthorizationDeniedError('Sandbox reset denied');
  }
}
