import type { AccountApprovalAuthorityView, ProviderHealthView } from '@slacato/contracts';

export type ProviderRuntimeDescriptor = Readonly<Pick<
  ProviderHealthView,
  'provider' | 'outputMode' | 'pinnedGenerationModel' | 'pinnedEmbeddingModel'
>>;

/** Reads canonical, account-scoped approval authority without consulting session roles or evidence grants. */
export interface ApprovalAuthorityQuery {
  /** Looks up every account authority granted to the requested persona. */
  forPersona(personaId: string): Promise<readonly AccountApprovalAuthorityView[]>;
}

export type DiagnosticsModuleOptions = Readonly<{
  providerRuntime: ProviderRuntimeDescriptor;
  approvalAuthorities: ApprovalAuthorityQuery;
}>;

export const PROVIDER_RUNTIME_DESCRIPTOR = Symbol('PROVIDER_RUNTIME_DESCRIPTOR');
export const APPROVAL_AUTHORITY_QUERY = Symbol('APPROVAL_AUTHORITY_QUERY');
