/**
 * Shared read-only share-link helper (extracted for the 3rd share surface, P10-B3
 * notebooks — red-team M6/DRY). A slug is a 128-bit CSPRNG capability token: anyone
 * with the link can view the cached result; regenerating mints a new slug (revoking
 * the old). Used by dashboards, reports, and notebooks.
 */
import { randomBytes } from 'node:crypto';

export function generateShareSlug(): string {
  return randomBytes(16).toString('hex');
}
