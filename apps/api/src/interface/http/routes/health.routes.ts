import type { Database } from '../../../infrastructure/persistence/database.js';
import type { ApplicationServer } from '../server-types.js';

const processStartedAt = Date.now();

/**
 * Whether a service this gateway talks to is answering its own liveness probe.
 *
 * Informational only. Readiness is decided by the database, because a gateway
 * with its database is one that can serve, record and refuse correctly; a
 * provider or a notification platform that is down costs a payment a refusal or
 * an event a deferral, both of which the gateway handles without help.
 */
export type IntegrationProbe = () => Promise<boolean>;

export interface HealthRouteDependencies {
  readonly database: Database;
  /**
   * Keyed by the integration's name. Absent when the integration is not
   * configured, which is reported as such rather than as down.
   */
  readonly integrations?: Readonly<Record<string, IntegrationProbe | undefined>>;
}

type IntegrationStatus = 'up' | 'down' | 'not_configured';

async function probe(check: IntegrationProbe | undefined): Promise<IntegrationStatus> {
  if (check === undefined) {
    return 'not_configured';
  }
  try {
    return (await check()) ? 'up' : 'down';
  } catch {
    return 'down';
  }
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
    const integrations = dependencies.integrations ?? {};
    const [database, ...probed] = await Promise.all([
      dependencies.database.checkHealth(),
      ...Object.values(integrations).map((check) => probe(check)),
    ]);

    const checks = {
      database: {
        status: database.isReachable ? 'up' : 'down',
        durationMilliseconds: Math.round(database.durationMilliseconds * 100) / 100,
      },
      // Reported beside the database and never counted with it: see IntegrationProbe.
      integrations: Object.fromEntries(
        Object.keys(integrations).map((name, index) => [
          name,
          { status: probed[index] ?? 'not_configured', required: false },
        ]),
      ),
    };

    if (database.isReachable) {
      return { status: 'ready', checks };
    }

    return reply.code(503).send({ status: 'not_ready', checks });
  });
}
