import { z } from 'zod';

/**
 * What every entrypoint needs: how to log, and how to reach the database.
 *
 * Split out so a process is never required to supply a secret it has no use for.
 * The migration runner connects as the schema owner, which is the most privileged
 * role in the system; demanding the API key pepper from it would put a secret
 * into the environment of the one container that must never need it.
 */
const baseEnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MILLISECONDS: z.coerce.number().int().min(100).default(5000),
});

const environmentSchema = baseEnvironmentSchema.extend({
  HTTP_HOST: z.string().min(1).default('0.0.0.0'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HTTP_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(262_144),
  HTTP_REQUEST_TIMEOUT_MILLISECONDS: z.coerce.number().int().min(1000).default(30_000),

  REDIS_URL: z.string().min(1),

  // Verifying an API key needs this on every request. It lives outside the
  // database on purpose: a dump alone must not yield a usable key.
  API_KEY_PEPPER: z.string().min(32),

  // Absent by default. Without them no Appmax provider is registered, and a
  // payment is refused with no_provider_available rather than failing obscurely
  // partway through a call that was never going to work.
  APPMAX_CLIENT_ID: z.string().default(''),
  APPMAX_CLIENT_SECRET: z.string().default(''),
  // Which Appmax the credentials above belong to. Payments in the other
  // environment find no provider and are refused, rather than being served a code
  // from the wrong world.
  APPMAX_ENVIRONMENT: z.enum(['SANDBOX', 'PRODUCTION']).default('SANDBOX'),

  // How often the reconciliation worker looks for uncertain payments. Lower costs
  // idle queries; higher is how long a resolvable payment stays uncertain.
  RECONCILIATION_POLL_MILLISECONDS: z.coerce.number().int().min(250).default(5000),
  RECONCILIATION_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
  // Long enough to cover an inquiry, short enough that a worker that dies does not
  // delay a payment noticeably. It is a lease, never a lock.
  RECONCILIATION_LEASE_SECONDS: z.coerce.number().int().min(5).max(3600).default(120),
  RECONCILIATION_MAXIMUM_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(12),
  // How long a payment may sit mid-flight before it is treated as abandoned.
  // Generous by default: sweeping one that is merely slow would move it out from
  // under the request still working on it.
  RECONCILIATION_STRANDED_AFTER_SECONDS: z.coerce.number().int().min(60).default(900),

  // The unguessable segment of the provider notification URL. Appmax sends no
  // signature of any kind, so this bounds who can reach the endpoint at all. It
  // is not what protects the money: a notification can only schedule an
  // authenticated read, and the database refuses to fund a payment on anything
  // less.
  WEBHOOK_PATH_SECRET: z.string().min(24),

  // CryptoPay, the crypto provider. Absent by default, like Appmax: without a
  // base URL and a key no crypto provider is registered and a crypto payment is
  // refused with no_provider_available.
  CRYPTOPAY_BASE_URL: z.string().default(''),
  CRYPTOPAY_API_KEY: z.string().default(''),
  // Which environment the key above belongs to. A cp_test_ key is SANDBOX; the
  // registration is bound to it, so a production payment never reaches a test
  // chain.
  CRYPTOPAY_ENVIRONMENT: z.enum(['SANDBOX', 'PRODUCTION']).default('SANDBOX'),
  // The chain family every crypto payment is created on, and the assets this
  // gateway offers there. CryptoPay resolves the family to a deployment itself.
  CRYPTOPAY_NETWORK: z.string().min(1).default('polygon'),
  CRYPTOPAY_CURRENCIES: z.string().default('USDC'),
  // Where CryptoPay must deliver its signed notifications: this gateway's own
  // webhook endpoint, as CryptoPay can reach it.
  CRYPTOPAY_CALLBACK_URL: z.string().default(''),
  // The whsec_ secrets CryptoPay signs with, comma separated so a rotation can
  // overlap. Verified against the raw bytes of every notification; a notification
  // that does not verify is refused before it is read.
  CRYPTOPAY_WEBHOOK_SECRETS: z.string().default(''),

  // The WhatsApp Notification Platform, which the paid event is handed to.
  // Absent by default: without both, events stay pending and are reported as
  // such, and no payment is affected either way.
  WHATSAPP_NOTIFICATION_BASE_URL: z.string().default(''),
  WHATSAPP_NOTIFICATION_API_KEY: z.string().default(''),
  EVENT_DELIVERY_POLL_MILLISECONDS: z.coerce.number().int().min(250).default(2000),
  EVENT_DELIVERY_MAXIMUM_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(10),

  // Browser origins allowed to call the API directly, comma separated. Empty
  // means no browser origin is: the API answers no preflight and sets no CORS
  // header, which is the right default for a server-to-server surface.
  HTTP_CORS_ALLOWED_ORIGINS: z.string().default(''),
});

export type Environment = z.infer<typeof environmentSchema>;

/**
 * The subset the logger and the database need. Every Environment satisfies it.
 */
export type DatabaseEnvironment = z.infer<typeof baseEnvironmentSchema>;

export class EnvironmentValidationError extends Error {
  public constructor(issues: string) {
    super(`Invalid environment configuration:\n${issues}`);
    this.name = 'EnvironmentValidationError';
  }
}

/**
 * Configuration is validated once at startup and never read from process.env again.
 * A missing variable must stop the process before it accepts a request, not surface
 * as an undefined halfway through handling a payment.
 */
export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  return parseOrThrow(environmentSchema, source);
}

/**
 * For entrypoints that only touch the database — the migration runner, and the
 * tooling around it. Asking these for HTTP or credential configuration would
 * make them fail on values they would never read.
 */
export function loadDatabaseEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): DatabaseEnvironment {
  return parseOrThrow(baseEnvironmentSchema, source);
}

function parseOrThrow<Schema extends z.ZodType>(
  schema: Schema,
  source: NodeJS.ProcessEnv,
): z.infer<Schema> {
  const result = schema.safeParse(source);
  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new EnvironmentValidationError(issues);
}
