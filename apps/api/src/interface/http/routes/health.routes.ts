import type { Database } from '../../../infrastructure/persistence/database.js';
import type { ApplicationServer } from '../server-types.js';

const processStartedAt = Date.now();

export interface HealthRouteDependencies {
  readonly database: Database;
}

/**
 * Liveness and readiness are separate on purpose. Liveness answers "is this process
 * alive", so an orchestrator does not restart a healthy container because a
 * dependency is briefly unavailable. Readiness answers "should traffic arrive here",
 * which is the question a load balancer needs answered.
 */
export function registerHealthRoutes(
  server: ApplicationServer,
  dependencies: HealthRouteDependencies,
): void {
  server.get('/health', () => ({
    status: 'ok',
    service: 'payment-gateway',
    uptimeSeconds: Math.floor((Date.now() - processStartedAt) / 1000),
  }));

  server.get('/ready', async (_request, reply) => {
    const database = await dependencies.database.checkHealth();

    const checks = {
      database: {
        status: database.isReachable ? 'up' : 'down',
        durationMilliseconds: Math.round(database.durationMilliseconds * 100) / 100,
      },
    };

    if (database.isReachable) {
      return { status: 'ready', checks };
    }

    return reply.code(503).send({ status: 'not_ready', checks });
  });
}
