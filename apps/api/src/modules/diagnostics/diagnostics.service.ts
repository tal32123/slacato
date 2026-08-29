import { Inject, Injectable } from '@nestjs/common';
import type { DemoDiagnosticsResponse, PermissionGrantView } from '@slacato/contracts';
import type { PermissionGrant } from '@slacato/core';
import { HealthService } from '../health/health.service.js';
import type { AuthenticatedRequest } from '../auth/guard.js';
import {
  APPROVAL_AUTHORITY_QUERY,
  PROVIDER_RUNTIME_DESCRIPTOR,
  type ApprovalAuthorityQuery,
  type ProviderRuntimeDescriptor
} from './contracts.js';

type AuthenticatedSession = NonNullable<AuthenticatedRequest['auth']>;

/** Builds a read-only diagnostics view from injected runtime and authorization facts. */
@Injectable()
export class DiagnosticsService {
  public constructor(
    private readonly health: HealthService,
    @Inject(PROVIDER_RUNTIME_DESCRIPTOR) private readonly runtime: ProviderRuntimeDescriptor,
    @Inject(APPROVAL_AUTHORITY_QUERY) private readonly approvalAuthorities: ApprovalAuthorityQuery
  ) {}

  /** Returns current runtime health, source permissions, and canonical account approval authorities. */
  public async view(session: AuthenticatedSession): Promise<DemoDiagnosticsResponse> {
    const [readiness, approvalAuthorities] = await Promise.all([
      this.health.readiness(),
      this.approvalAuthorities.forPersona(session.persona.userId)
    ]);
    return {
      sessionVersion: session.claims.version,
      permissions: session.persona.grants.map(permissionView),
      approvalAuthorities,
      providerHealth: {
        ...this.runtime,
        indexHealth: readiness.checks.index,
        runtimeReadiness: readiness.status,
        checks: readiness.checks
      }
    };
  }
}

/** Projects a source permission without inferring any approval authority. */
function permissionView(grant: PermissionGrant): PermissionGrantView {
  return {
    accountId: grant.accountId,
    sourceType: grant.sourceType,
    canRead: grant.canRead,
    restrictedOpportunityAccess: grant.canReadRestricted,
    sensitivePricing: grant.sensitivePricing,
    canRequestApproval: grant.canRequestApproval
  };
}
