import { Inject, Injectable } from '@nestjs/common';
import type { DemoDiagnosticsResponse, DecisionAuthorityView, PermissionGrantView } from '@slacato/contracts';
import type { PermissionGrant } from '@slacato/core';
import { HealthService } from '../health/health.service.js';
import type { AuthenticatedRequest } from '../auth/guard.js';
import { DIAGNOSTICS_OPTIONS, type DiagnosticsModuleOptions } from './contracts.js';

type AuthenticatedSession = NonNullable<AuthenticatedRequest['auth']>;

@Injectable()
export class DiagnosticsService {
  public constructor(
    private readonly health: HealthService,
    @Inject(DIAGNOSTICS_OPTIONS) private readonly options: DiagnosticsModuleOptions
  ) {}

  public async view(session: AuthenticatedSession): Promise<DemoDiagnosticsResponse> {
    const readiness = await this.health.readiness();
    return {
      sessionVersion: session.claims.version,
      permissions: session.persona.grants.map((grant) => permissionView(session.persona.role, grant)),
      providerHealth: {
        provider: this.options.provider,
        outputMode: this.options.provider === 'mock' ? 'deterministic_mock'
          : this.options.provider === 'openrouter' ? 'native_schema' : 'capability_probe_required',
        pinnedGenerationModel: this.options.pinnedGenerationModel,
        pinnedEmbeddingModel: this.options.pinnedEmbeddingModel,
        indexHealth: readiness.checks.index,
        runtimeReadiness: readiness.status,
        checks: readiness.checks
      }
    };
  }
}

function permissionView(role: string, grant: PermissionGrant): PermissionGrantView {
  return {
    accountId: grant.accountId,
    sourceType: grant.sourceType,
    canRead: grant.canRead,
    restrictedOpportunityAccess: grant.canReadRestricted,
    sensitivePricing: grant.sensitivePricing,
    canRequestApproval: grant.canRequestApproval,
    decisionAuthority: decisionAuthority(role, grant.canApprove)
  };
}

function decisionAuthority(role: string, canApprove: boolean): DecisionAuthorityView {
  return {
    accountOwner: canApprove && (role === 'Account Owner' || role === 'Restricted Account Owner'),
    salesLeader: canApprove && (role === 'Sales Leader' || role === 'Restricted Sales Leader'),
    dealDesk: canApprove && role === 'Deal Desk Approver',
    legalReviewer: canApprove && role === 'Legal Reviewer'
  };
}
