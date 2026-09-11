import Fastify from 'fastify';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Environment } from '../../infrastructure/configuration/environment.js';
import type { Database } from '../../infrastructure/persistence/database.js';
import type { ApplicationServer } from './server-types.js';
import { registerErrorHandling } from './error-handling.js';
import { registerHealthRoutes } from './routes/health.routes.js';
import type { HealthRouteDependencies } from './routes/health.routes.js';
import { registerPaymentRoutes } from './routes/payment.routes.js';
import { registerWebhookRoutes } from './routes/webhook.routes.js';
import type { WebhookRouteDependencies } from './routes/webhook.routes.js';
import type { PaymentRouteDependencies } from './routes/payment.routes.js';

export interface ServerDependencies {
  readonly environment: Environment;
  readonly logger: Logger;
  readonly database: Database;
  readonly authentication: PaymentRouteDependencies['authentication'];
  readonly payments: PaymentRouteDependencies['payments'];
  readonly paymentReads: PaymentRouteDependencies['paymentReads'];
  readonly webhooks: WebhookRouteDependencies;
  /**
   * Browser origins allowed to call the API directly. Empty by default, in which
   * case no CORS header is ever set and a preflight is answered like any other
   * unknown route.
   */
  readonly corsAllowedOrigins: readonly string[];
  readonly integrations: NonNullable<HealthRouteDependencies['integrations']>;
}

const REQUEST_IDENTIFIER_PATTERN = /^[\w-]{8,64}$/;

export function createServer(dependencies: ServerDependencies): ApplicationServer {
  const { environment, logger } = dependencies;

  const server = Fastify({
    loggerInstance: logger,
    bodyLimit: environment.HTTP_BODY_LIMIT_BYTES,
    requestTimeout: environment.HTTP_REQUEST_TIMEOUT_MILLISECONDS,
    maxParamLength: 256,
    // An unvalidated client-supplied identifier is a log-injection vector, so a
    // malformed one is replaced rather than trusted.
    genReqId: (request) => {
      const supplied = request.headers['x-request-id'];
      if (typeof supplied === 'string' && REQUEST_IDENTIFIER_PATTERN.test(supplied)) {
        return supplied;
      }
      return crypto.randomUUID();
    },
  });

  server.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
    void reply.header('cache-control', 'no-store');
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('referrer-policy', 'no-referrer');
    void reply.header('x-frame-options', 'DENY');
  });

  registerCors(server, dependencies.corsAllowedOrigins);
  registerErrorHandling(server);

  registerHealthRoutes(server, {
    database: dependencies.database,
    integrations: dependencies.integrations,
  });
  registerPaymentRoutes(server, {
    authentication: dependencies.authentication,
    payments: dependencies.payments,
    paymentReads: dependencies.paymentReads,
  });
  registerWebhookRoutes(server, dependencies.webhooks);

  return server;
}

/**
 * Just enough CORS for a browser to create and read payments, and no more.
 *
 * Origins are matched exactly against a configured list, never reflected. The
 * one header a browser must be allowed to read back is the request id, so a
 * failure on a demo page can be quoted against the server log.
 */
function registerCors(server: ApplicationServer, allowedOrigins: readonly string[]): void {
  if (allowedOrigins.length === 0) {
    return;
  }
  const allowed = new Set(allowedOrigins);

  server.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !allowed.has(origin)) {
      return;
    }
    void reply.header('access-control-allow-origin', origin);
    void reply.header('vary', 'origin');
    void reply.header('access-control-expose-headers', 'x-request-id');
    if (request.method !== 'OPTIONS') {
      return;
    }
    void reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    void reply.header(
      'access-control-allow-headers',
      'authorization, content-type, idempotency-key, x-request-id',
    );
    void reply.header('access-control-max-age', '600');
    return reply.code(204).send();
  });
}
