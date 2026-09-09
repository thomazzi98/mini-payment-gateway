/**
 * What an authenticated caller is allowed to do, and the vocabulary for refusing
 * them. Pure: no database, no HTTP, no clock of its own.
 */

export const API_KEY_SCOPES = [
  'payments:read',
  'payments:write',
  'refunds:write',
  'providers:read',
  'providers:write',
  'webhooks:read',
  'webhooks:write',
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export function isApiKeyScope(candidate: unknown): candidate is ApiKeyScope {
  return typeof candidate === 'string' && API_KEY_SCOPES.includes(candidate as ApiKeyScope);
}

export type Environment = 'SANDBOX' | 'PRODUCTION';

export interface ApiKeyPrincipal {
  readonly apiKeyId: string;
  readonly organizationId: string;
  readonly environment: Environment;
  readonly scopes: readonly ApiKeyScope[];
}

/**
 * Why a request was refused.
 *
 * Recorded for audit and metrics, and deliberately never returned to the caller.
 * Telling someone that a key exists but is revoked, rather than simply that it is
 * unusable, hands them a probe for which identifiers are real.
 */
export type AuthenticationFailureReason =
  | 'malformed_key'
  | 'unknown_key'
  | 'invalid_secret'
  | 'revoked'
  | 'expired'
  | 'organization_archived';

export type AuthenticationResult =
  | { readonly outcome: 'authenticated'; readonly principal: ApiKeyPrincipal }
  | { readonly outcome: 'rejected'; readonly reason: AuthenticationFailureReason };

export function authenticated(principal: ApiKeyPrincipal): AuthenticationResult {
  return { outcome: 'authenticated', principal };
}

export function rejected(reason: AuthenticationFailureReason): AuthenticationResult {
  return { outcome: 'rejected', reason };
}

export function hasScope(principal: ApiKeyPrincipal, required: ApiKeyScope): boolean {
  return principal.scopes.includes(required);
}

export function missingScopes(
  principal: ApiKeyPrincipal,
  required: readonly ApiKeyScope[],
): ApiKeyScope[] {
  return required.filter((scope) => !hasScope(principal, scope));
}

/**
 * A key is usable only while every one of these holds. Expiry is optional, so a
 * key without one never expires; revocation is immediate and permanent.
 */
export interface ApiKeyLifecycle {
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly organizationArchivedAt: Date | null;
}

export function lifecycleRejection(
  lifecycle: ApiKeyLifecycle,
  now: Date,
): AuthenticationFailureReason | undefined {
  if (lifecycle.revokedAt !== null && lifecycle.revokedAt.getTime() <= now.getTime()) {
    return 'revoked';
  }
  if (lifecycle.expiresAt !== null && lifecycle.expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  if (lifecycle.organizationArchivedAt !== null) {
    return 'organization_archived';
  }
  return undefined;
}
