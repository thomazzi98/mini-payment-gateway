import Fastify from 'fastify';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Environment } from '../../infrastructure/configuration/environment.js';
import type { Database } from '../../infrastructure/persistence/database.js';
import type { ApplicationServer } from './server-types.js';
import { registerHealthRoutes } from './routes/health.routes.js';

export interface ServerDependencies {
  readonly environment: Environment;
  readonly logger: Logger;
  readonly database: Database;
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

  registerHealthRoutes(server, { database: dependencies.database });

  return server;
}
