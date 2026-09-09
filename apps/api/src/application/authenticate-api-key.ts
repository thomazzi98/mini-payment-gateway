import { hashApiKeySecret, isApiKeySecretValid, parseApiKey } from '@gateway/shared/server';
import type { Secret } from '@gateway/shared/server';
import { authenticated, lifecycleRejection, rejected } from '../domain/api-key/api-key.js';
import type { AuthenticationResult } from '../domain/api-key/api-key.js';
import type { ApiKeyRepository } from './ports/api-key.repository.js';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface AuthenticateApiKeyDependencies {
  readonly repository: ApiKeyRepository;
  readonly pepper: Secret;
  readonly clock: Clock;
}

export async function authenticateApiKey(
  presentedKey: unknown,
  dependencies: AuthenticateApiKeyDependencies,
): Promise<AuthenticationResult> {
  const parsed = parseApiKey(presentedKey);
  if (parsed === undefined) {
    return rejected('malformed_key');
  }

  const stored = await dependencies.repository.findByIdentifier(parsed.identifier);

  if (stored === undefined) {
    // Burn the same work an existing key would have cost before refusing.
    // Without this an unknown identifier returns before any HMAC is computed,
    // while a known one pays for it, and the difference is measurable — which
    // turns the endpoint into an oracle for which identifiers exist.
    hashApiKeySecret(parsed.identifier, parsed.secret, dependencies.pepper);
    return rejected('unknown_key');
  }

  const isSecretValid = isApiKeySecretValid(
    parsed.identifier,
    parsed.secret,
    stored.keyHash,
    dependencies.pepper,
  );
  if (!isSecretValid) {
    return rejected('invalid_secret');
  }

  // Checked after the secret, on purpose. Answering "revoked" to someone holding
  // the wrong secret would confirm that the identifier is real.
  const lifecycleProblem = lifecycleRejection(stored, dependencies.clock.now());
  if (lifecycleProblem !== undefined) {
    return rejected(lifecycleProblem);
  }

  return authenticated({
    apiKeyId: stored.apiKeyId,
    organizationId: stored.organizationId,
    environment: stored.environment,
    scopes: stored.scopes,
  });
}
