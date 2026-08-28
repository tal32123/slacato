import { SetMetadata } from '@nestjs/common';

export const ENDPOINT_ACCESS = Symbol('ENDPOINT_ACCESS');
export type EndpointAccess = 'browser_public' | 'non_browser_public';

/** Permits an unauthenticated browser endpoint while retaining origin and mutation defenses. */
export const BrowserPublic = (): MethodDecorator & ClassDecorator => SetMetadata(ENDPOINT_ACCESS, 'browser_public' satisfies EndpointAccess);

/** Permits read-only machine traffic such as liveness and readiness probes. */
export const NonBrowserPublic = (): MethodDecorator & ClassDecorator => SetMetadata(ENDPOINT_ACCESS, 'non_browser_public' satisfies EndpointAccess);
