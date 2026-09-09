import { pino } from 'pino';
import type { Logger } from 'pino';
import type { DatabaseEnvironment } from '../configuration/environment.js';

export type { Logger } from 'pino';

/**
 * Redaction is applied at serialization time rather than at each call site, so a
 * secret nested inside an object that was logged wholesale is still removed.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["idempotency-key"]',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.secret',
  '*.token',
  '*.accessToken',
  '*.clientSecret',
  '*.apiKey',
  '*.credentials',
  '*.credentialValue',
  '*.encryptionKey',
  'password',
  'secret',
  'token',
  'accessToken',
  'clientSecret',
  'apiKey',
];

export function createLogger(environment: DatabaseEnvironment): Logger {
  return pino({
    level: environment.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    base: { service: 'payment-gateway' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
