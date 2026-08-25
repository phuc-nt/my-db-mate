/**
 * Constants shared between the demo service and client components.
 *
 * These live in `lib/` rather than in `demo-service.ts` because importing that
 * service from a client component drags its whole dependency tree — including
 * DuckDB's native bindings — into the browser bundle, which does not build.
 */
export const DEMO_CONNECTION_NAME = 'Demo — Online Shop';
