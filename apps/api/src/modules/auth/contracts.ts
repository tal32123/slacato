import type { Persona } from '@slacato/contracts';
import type { PermissionGrant } from '@slacato/core';

export type CanonicalPersona = Readonly<Persona & { grants: readonly PermissionGrant[] }>;

/** Canonical identity lookup; adapters may only return identities already ingested into the system of record. */
export interface CanonicalPersonaDirectory {
  list(): Promise<readonly CanonicalPersona[]>;
  findById(userId: string): Promise<CanonicalPersona | undefined>;
}

export type AuthModuleOptions = Readonly<{
  sessionSecret: string;
  environment: 'development' | 'test' | 'production';
  allowedOrigins: readonly string[];
  personaDirectory: CanonicalPersonaDirectory;
}>;

export const AUTH_OPTIONS = Symbol('AUTH_OPTIONS');
export const PERSONA_DIRECTORY = Symbol('PERSONA_DIRECTORY');
