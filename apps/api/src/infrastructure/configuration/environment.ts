import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  HTTP_HOST: z.string().min(1).default('0.0.0.0'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HTTP_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(262_144),
  HTTP_REQUEST_TIMEOUT_MILLISECONDS: z.coerce.number().int().min(1000).default(30_000),

  DATABASE_URL: z.string().min(1),
  DATABASE_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MILLISECONDS: z.coerce.number().int().min(100).default(5000),

  REDIS_URL: z.string().min(1),

  // Verifying an API key needs this on every request. It lives outside the
  // database on purpose: a dump alone must not yield a usable key.
  API_KEY_PEPPER: z.string().min(32),

  // Absent by default. Without them no Appmax provider is registered, and a
  // payment is refused with no_provider_available rather than failing obscurely
  // partway through a call that was never going to work.
  APPMAX_CLIENT_ID: z.string().default(''),
  APPMAX_CLIENT_SECRET: z.string().default(''),
});

export type Environment = z.infer<typeof environmentSchema>;

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
  const result = environmentSchema.safeParse(source);
  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new EnvironmentValidationError(issues);
}
