import { Controller, Get, Inject, Logger, Post } from '@nestjs/common';
import {
  type SandboxResetReportView,
  type SandboxResetRequest,
  sandboxResetReportSchema,
  sandboxResetRequestSchema
} from '@slacato/contracts';
import type { ResetSandbox } from '@slacato/core';
import { toHttpError } from '../../common/http/to-http-error.js';
import { ZodBody, ZodResponse } from '../../common/wire/zod.decorators.js';
import type { AuthenticatedPrincipal } from '../auth/contracts.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import { RESET_SANDBOX } from './contracts.js';

/**
 * Erases the demo sandbox, for deployments that were explicitly configured to allow it.
 *
 * These routes exist only when composition decided this process is connected to a designated
 * sandbox (see `resolveSandboxResetPolicy`). Elsewhere the module is never registered, so the
 * paths do not resolve at all - the capability is absent rather than merely refused, and the
 * interface has nothing to discover.
 *
 * Both routes carry the default security posture: a signed session, browser provenance, and - on
 * the mutation - the same CSRF token every other state change in this API requires. An actor
 * without standing is refused by the application command, and `toHttpError` reports that refusal
 * as 404, identical to what an unconfigured deployment returns. So a caller who is not entitled
 * cannot tell whether they lack permission or the sandbox capability was never enabled.
 */
@Controller('api/sandbox')
export class SandboxController {
  private readonly logger = new Logger(SandboxController.name);

  /** Creates the controller with the sandbox reset command bound to the designated database. */
  public constructor(@Inject(RESET_SANDBOX) private readonly resetSandbox: ResetSandbox) {}

  /**
   * Reports what a reset would erase, so the confirmation can name real numbers.
   *
   * Asking for a preview before destroying anything is the point: a dialog that says "3 runs, 8
   * approval requests, 325 trace spans" is a decision, and "are you sure?" is a reflex.
   */
  @Get('reset')
  @ZodResponse(sandboxResetReportSchema)
  public async preview(
    @CurrentPrincipal() principal: AuthenticatedPrincipal
  ): Promise<SandboxResetReportView> {
    try {
      return await this.resetSandbox.preview({ actorId: principal.persona.userId });
    } catch (error) {
      return toHttpError(error);
    }
  }

  /** Erases the sandbox for an entitled principal and reports exactly what went. */
  @Post('reset')
  @ZodResponse(sandboxResetReportSchema)
  public async reset(
    @ZodBody(sandboxResetRequestSchema) input: SandboxResetRequest,
    @CurrentPrincipal() principal: AuthenticatedPrincipal
  ): Promise<SandboxResetReportView> {
    // The body's only field is the confirmation literal, and validating it is the whole job: the
    // strict schema rejects an absent or mistyped body before this handler runs, so a bare POST -
    // a stray click, a replayed URL, a curl with no payload - cannot erase a sandbox by accident.
    void input;
    try {
      const report = await this.resetSandbox.execute({ actorId: principal.persona.userId });
      this.logger.warn({
        event: 'sandbox_reset',
        database: report.database,
        runs: report.tally.runs,
        approvalSubjects: report.tally.approvalSubjects
      });
      return report;
    } catch (error) {
      return toHttpError(error);
    }
  }
}
