import type { Persona } from '@slacato/contracts';
import type { PermissionGrant } from '@slacato/core';

export type CanonicalPersona = Readonly<Persona & { grants: readonly PermissionGrant[] }>;
/** Stable identity and session generation exposed to protected application handlers. */
export type AuthenticatedPrincipal = Readonly<{
  claims: Readonly<{ userId: string; issuedAt: number; version: string }>;
  persona: CanonicalPersona;
}>;

/** @internal Request state shared only by the security guard and principal decorator. */
export type PrincipalAwareRequest = {
  auth?: AuthenticatedPrincipal;
};

/** Canonical identity lookup; adapters may only return identities already ingested into the system of record. */
export interface CanonicalPersonaDirectory {
  list(): Promise<readonly CanonicalPersona[]>;
  findById(userId: string): Promise<CanonicalPersona | undefined>;
}
export interface SessionRegistry {
  activate(input: Readonly<{ version: string; userId: string; expiresAt: Date }>): Promise<void>;
  revoke(version: string): Promise<void>;
  isActive(version: string, userId: string): Promise<boolean>;
}


export type AuthModuleOptions = Readonly<{
  sessionSecret: string;
  environment: 'development' | 'test' | 'production';
  allowedOrigins: readonly string[];
  personaDirectory: CanonicalPersonaDirectory;
  sessionRegistry?: SessionRegistry;
}>;

export const AUTH_OPTIONS = Symbol('AUTH_OPTIONS');
export const PERSONA_DIRECTORY = Symbol('PERSONA_DIRECTORY');
export const SESSION_REGISTRY = Symbol('SESSION_REGISTRY');
