# Task 11 Report — Responsive Product Shell, Persona Settings, and Demo Diagnostics

## Outcome

Implemented the protected, responsive SlaCato product shell and the typed settings/diagnostics slice. The browser now bootstraps a signed session through a data-router loader, uses TanStack Query as the single fetch owner, versions authorization-sensitive query keys by signed session version, and tears down streams, overlays, scoped queries, and cross-tab state before a persona or logout transition can render stale protected content.

The product surface uses the approved Verified Converged Workspace direction: forest desktop rail, pale paper workspace, Geist, semantic Cato palette tokens, no gradients, and no Slack trade dress. Settings contains persona/session controls only. Demo Diagnostics is secondary and read-only.

## RED evidence

### Initial product behavior

Command:

```text
pnpm test:e2e -- responsive-shell.spec.ts settings.spec.ts --workers=1
```

After starting a fresh isolated PostgreSQL container and migrating/ingesting the canonical fixture, Playwright reached the browser assertions. The first Task 11 assertions failed because selecting Maya returned to `/` instead of the requested `/settings`; the settings shell, navigation, and diagnostics did not exist. Result at that point: 2 failed, 6 did not run, and 5 pre-existing login tests passed (the package-script separator also selected `login.spec.ts`).

The first two attempts did not reach browser assertions because the existing persisted local database could not reapply migrations. No volume was deleted; verification used a temporary PostgreSQL container with a fresh data directory.

### Accessibility mode behavior

A focused forced-colors/reduced-motion test initially failed because a programmatically focused navigation item computed `outline-style: none` in forced-colors mode. The global forced-colors rule was corrected to preserve a 2px `CanvasText` outline for focused controls; the focused rerun passed 1/1.

A mobile Diagnostics axe pass then reported the lower-severity `aria-allowed-role` rule for `role="listitem"` on `<section>`. The mobile permission records were changed to a semantic `<ul>/<li>` structure; the focused desktop/mobile Diagnostics accessibility rerun passed 1/1 with zero axe violations.

## Implementation

### Typed contracts and endpoint

- `packages/contracts/src/diagnostics.ts`
  - `demoSessionSchema` / `DemoSession`
  - `permissionGrantViewSchema` / `PermissionGrantView`
  - separate Account Owner, Sales Leader, Deal Desk, and Legal Reviewer authority fields
  - `providerHealthViewSchema` / `ProviderHealthView`
  - `demoDiagnosticsResponseSchema`
- `apps/api/src/modules/diagnostics/*`
  - protected `GET /api/diagnostics`
  - strict Zod response boundary
  - request-persona grant projection without hidden account metadata
  - server-reported pinned provider/model values
  - truthful `HealthService` runtime and index readiness
- `apps/api/src/app.module.ts`, `apps/api/src/main.ts`, and `apps/api/src/modules/health/health.module.ts`
  - diagnostics composition and exported health projection

Decision authority is derived only when the canonical grant has `canApprove`, and then split by the authenticated canonical role. `canRequestApproval` remains a separate field and never implies authority.

### Shared browser lifecycle

- `apps/web/src/api/client.ts`
  - same-origin credentialed fetch
  - typed Zod parsing for every response
  - safe 401/403/CSRF error classification
- `apps/web/src/api/session.ts`
  - shared `QueryClient`
  - shared session/persona/CSRF/diagnostics query options
  - `['scoped', sessionVersion, resource]` authorization-sensitive key convention
  - stream registry and connection-generation fence
  - overlay closer registry
  - synchronous scoped/CSRF cancellation and removal initiation before mutation/navigation
  - `BroadcastChannel('slacato-session')` persona/logout propagation
  - other tabs close streams/overlays, remove session/scoped data, and reload or leave protected routing before rendering again
  - safe intended-destination parsing

The previous component-owned auth client and placeholder workspace route were removed. Login now uses the same session transition module, including intended-destination restoration and cross-tab notification.

### Router and shell

- `apps/web/src/main.tsx`
  - one protected nested data-router tree
  - root bootstrap loader
  - foreground `fetchQuery` session revalidation on every protected navigation, with shared query options retaining fetch ownership
  - route-level pending and error states
  - protected catch-all not-found state
- `apps/web/src/routes/root.tsx`
  - protected session loader and shell root
  - primary Deals, Runs, and Approvals landing destinations with accurate product/authority guidance and no fabricated data
- `apps/web/src/routes/{settings,diagnostics,route-error,route-pending,not-found}.tsx`
- `apps/web/src/components/{app-shell,mobile-nav,persona-menu,status-badge,permission-matrix}.tsx`
  - 72px collapsed / 240px expanded rail at `lg`
  - four-item bottom navigation below `lg` with safe-area padding
  - 1280px maximum content width
  - active destination via `aria-current`
  - skip link and focusable `main`
  - text/icon status meaning in addition to color
  - complete desktop table and mobile stacked permission records

### Design-system and access-state updates

- `apps/web/src/styles/globals.css`
  - approved Cato palette centralized as semantic/brand Tailwind tokens
  - tinted neutrals, attention foreground, token-based focus color
  - reduced-motion and forced-colors rules
- `apps/web/src/components/ui/button.tsx`
  - all button sizes now provide at least a 44px target
- `apps/web/src/routes/login.tsx` and `apps/web/src/routes/unauthorized.tsx`
  - removed one-off color values and reused semantic tokens
  - login actions use the shared lifecycle

## GREEN evidence

### Task 11 focused browser suite

Command:

```text
pnpm exec playwright test tests/e2e/responsive-shell.spec.ts tests/e2e/settings.spec.ts --workers=1
```

Result:

```text
Running 9 tests using 1 worker
9 passed (10.5s)
```

The suite serializes persona/session changes and covers:

- 320, 390, 768, 1024, and 1440px
- 844×390 landscape phone
- 1024×600 short desktop
- 640px CSS viewport as the 200% zoom equivalent of a 1280px layout
- desktop rail and mobile bottom navigation
- every primary destination and intended href
- every visible link/button and radio-label target at 44px or larger
- horizontal overflow at every required viewport
- skip link, keyboard focus, focus order, `aria-current`, and intended destination
- route pending, error, and no-leak not-found states
- desktop and mobile axe scans with zero violations
- forced colors and reduced motion
- exact seller-assist copy and real diagnostics values
- permission versus four distinct decision authorities
- persona change and logout
- same-tab and cross-tab stream/overlay teardown, stale-identity removal, reauthorization, and logout propagation

### Related login flow

Command:

```text
pnpm exec playwright test tests/e2e/login.spec.ts --workers=1
```

Result: 5 passed.

### Type safety

Command:

```text
pnpm typecheck
```

Result: passed with no diagnostics.

## Runtime visual and accessibility review

The actual Vite/Nest surface was driven in Chromium rather than reviewed from source alone.

- 1440×900 Settings: expanded 240px forest rail, restrained paper workspace, clear active persona hierarchy, compact signed-session status, and balanced two-column session controls.
- 1440×900 Diagnostics: truthful mock provider/model values, visible `Runtime not configured`, all five dependency checks explicitly shown as not configured, and a readable full authority matrix.
- 320×720 Settings: single-column persona records, no horizontal overflow (`scrollWidth === clientWidth === 320`), usable header, persistent four-item bottom navigation, and 44px controls.
- 390×844 Diagnostics: stacked runtime facts and mobile permission records, no horizontal overflow (`scrollWidth === clientWidth === 390`), bottom navigation retained.
- Automated responsive coverage additionally exercised tablet, landscape phone, 1024px collapsed rail, short desktop, and 200% zoom equivalent behavior.
- Axe reported zero violations for the final desktop/mobile Settings and Diagnostics views. Forced-colors focus and reduced-motion duration were asserted directly.

## Concerns and grounded limitations

- `HealthModule` has no operational dependency probes configured in this composition. Its explicit `unconfigured` readiness state prevents the UI from claiming either observed health or observed failure. Wiring real database, migration, Redis, index, and model probes is outside Task 11.
- Mock mode reports `deterministic_mock`. Ollama mode reports `capability_probe_required` because the current API composition has no persisted credentialed capability-probe result; the UI does not claim an unobserved native output mode.
- The requested package-script form with a standalone `--` selected the existing login spec in addition to the two Task 11 specs in this pnpm/Playwright setup. Final isolated proof used explicit Playwright file paths and one worker.
- No formatter, linter, project-wide build, or project-wide test suite was run, per task constraints.

## Review-fix round 1

### Additional RED evidence

The review round began with focused tests that exposed the reported gaps:

```text
pnpm vitest run tests/unit/health.controller.test.ts
1 failed, 2 passed
```

The failure showed the unconfigured composition being reported as `not_ready` / `unavailable` instead of the required explicit `unconfigured` state.

```text
pnpm exec playwright test tests/e2e/responsive-shell.spec.ts tests/e2e/settings.spec.ts --workers=1
2 failed, 2 passed, 12 did not run
```

The first failures demonstrated that the desktop secondary navigation landmark was absent and the permission matrix omitted the read-permission column. Subsequent focused RED runs also exercised session-version mismatch, connection-generation mismatch, foreground session expiry, and invalid persona/logout response bodies before each path was made green.

### Review fixes

- Diagnostics now accepts a protected response only when both its `sessionVersion` and captured connection generation remain current. A mismatch hides protected content, tears down scoped state, fetches the authoritative session, and retries through the shared query option before rendering.
- Persona and logout mutations reconcile the authoritative signed cookie after any ambiguous parse/validation failure, with transition pending state and cross-tab persona/logout broadcasts preventing the prior identity from remaining rendered.
- Protected navigation foreground-refetches the signed session. Typed API 401 errors preserve a safe `returnTo`; 403 errors route to the opaque forbidden surface.
- Runtime health now distinguishes `unconfigured` from an observed dependency failure in both the strict contracts and Diagnostics UI.
- Desktop Diagnostics is an exact secondary destination. Desktop Settings is not marked current while Diagnostics is active; mobile Settings uses `aria-current="location"`.
- The permission matrix exposes read, restricted-opportunity, sensitive-pricing, request, and all four decision-authority values on desktop and mobile.
- The keyboard journey uses Tab, Shift+Tab, Enter, Space, ArrowDown, and Escape without programmatic focus shortcuts. Root bootstrap errors now retain a `main` landmark.
- The rail is asserted at 72px collapsed and 240px expanded across 1024px and 1440px. The 1024px Diagnostics grid constrains the wide matrix to an internal, keyboard-focusable horizontal scroller instead of expanding the document.

### Final review-fix verification

```text
pnpm exec playwright test tests/e2e/responsive-shell.spec.ts tests/e2e/settings.spec.ts --workers=1
16 passed (23.4s)

pnpm exec playwright test tests/e2e/login.spec.ts --workers=1
5 passed (6.3s)

pnpm vitest run tests/unit/health.controller.test.ts
3 passed

pnpm typecheck
passed with no diagnostics
```

The live Vite/Nest surface was reviewed again in Chromium. At 1024×900 the collapsed rail measured 72px, Diagnostics used the exact secondary current destination, the document measured `scrollWidth === clientWidth === 1024`, and the wider 1370px matrix remained inside an 886px keyboard-accessible scroller. At 390×844 the document measured `scrollWidth === clientWidth === 390`, the mobile Settings destination used `aria-current="location"`, and the complete stacked permission records remained readable. The final desktop/mobile axe path passed with zero violations.
