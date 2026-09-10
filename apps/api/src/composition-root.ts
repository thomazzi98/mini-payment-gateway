import { loadEnvironment } from './infrastructure/configuration/environment.js';
import type { Environment } from './infrastructure/configuration/environment.js';
import { createLogger } from './infrastructure/logging/logger.js';
import type { Logger } from './infrastructure/logging/logger.js';
import { Secret } from '@gateway/shared/server';
import { createConnectionPool, Database } from './infrastructure/persistence/database.js';
import { PostgresApiKeyRepository } from './infrastructure/persistence/api-key.repository.js';
import { PaymentCreationRepository } from './infrastructure/persistence/payment-creation.repository.js';
import { systemClock } from './application/authenticate-api-key.js';
import type { AuthenticateApiKeyDependencies } from './application/authenticate-api-key.js';
import { ProviderRegistry } from './application/provider-registry.js';
import type { RegisteredProvider } from './application/provider-registry.js';
import type { CreatePaymentDependencies } from './application/create-payment.use-case.js';
import { DEFAULT_RECONCILIATION_SCHEDULE } from './application/reconcile-payments.use-case.js';
import type { ReconciliationDependencies } from './application/reconcile-payments.use-case.js';
import { PaymentReconciliationRepository } from './infrastructure/persistence/payment-reconciliation.repository.js';
import {
  AppmaxPixProvider,
  APPMAX_DESCRIPTOR,
} from './infrastructure/providers/appmax/appmax-provider.js';
import { AppmaxTokenCache } from './infrastructure/providers/appmax/appmax-token-cache.js';
import { UndiciAppmaxTransport } from './infrastructure/providers/appmax/appmax-http-transport.js';

export interface ApplicationContext {
  readonly environment: Environment;
  readonly logger: Logger;
  readonly database: Database;
  readonly authentication: AuthenticateApiKeyDependencies;
  readonly payments: CreatePaymentDependencies;
  readonly reconciliation: ReconciliationDependencies;
  /**
   * The reconciliation backlog, for the worker to report at startup. Separate
   * from the use case dependencies because it answers a question about the system
   * rather than participating in resolving a payment.
   */
  readonly reconciliationInsight: PaymentReconciliationRepository;
  shutdown(): Promise<void>;
}

/**
 * Registers Appmax only when it is actually configured.
 *
 * A provider registered without credentials would fail every payment partway
 * through a call that was never going to work. Absent, the registry simply
 * offers nothing and the payment is refused with a reason that names the cause.
 */
function registerProviders(environment: Environment, logger: Logger): RegisteredProvider[] {
  if (environment.APPMAX_CLIENT_ID === '' || environment.APPMAX_CLIENT_SECRET === '') {
    logger.warn(
      { provider: 'appmax' },
      'appmax is not configured; no provider is registered for pix',
    );
    return [];
  }

  /**
   * Credentials belong to exactly one Appmax environment, so the registration
   * says which. A payment in the other environment then finds no candidate and is
   * refused, rather than being handed a code from the wrong world: a sandbox code
   * served to a production payment cannot be paid, and the merchant would be told
   * their customer had something to pay when they did not.
   */
  const appmaxEnvironment = environment.APPMAX_ENVIRONMENT;
  const transport = new UndiciAppmaxTransport(
    appmaxEnvironment,
    {
      clientId: environment.APPMAX_CLIENT_ID,
      clientSecret: new Secret(environment.APPMAX_CLIENT_SECRET),
    },
    logger,
  );
  const tokens = new AppmaxTokenCache(() => transport.fetchToken());

  logger.info(
    { provider: 'appmax', environment: appmaxEnvironment },
    'appmax registered for pix in one environment',
  );

  return [
    {
      descriptor: APPMAX_DESCRIPTOR,
      environment: appmaxEnvironment,
      pix: new AppmaxPixProvider(transport, tokens),
      priority: 1,
    },
  ];
}

/**
 * Everything this process uses is constructed here, explicitly, in dependency order.
 * There is no container and no runtime resolution step, so the wiring is greppable
 * and a missing dependency is a compile error rather than a boot-time surprise.
 */
export function buildApplicationContext(): ApplicationContext {
  const environment = loadEnvironment();
  const logger = createLogger(environment);
  const pool = createConnectionPool(environment);
  const database = new Database(pool);

  const authentication: AuthenticateApiKeyDependencies = {
    repository: new PostgresApiKeyRepository(pool),
    pepper: new Secret(environment.API_KEY_PEPPER),
    clock: systemClock,
  };

  // One registry, shared. Payment creation routes through it and reconciliation
  // looks providers up in it by code, so the two can never disagree about which
  // provider serves which environment.
  const providers = new ProviderRegistry(registerProviders(environment, logger));

  const payments: CreatePaymentDependencies = {
    store: new PaymentCreationRepository(pool),
    providers,
  };

  const reconciliationRepository = new PaymentReconciliationRepository(pool);
  const reconciliation: ReconciliationDependencies = {
    store: reconciliationRepository,
    stranded: reconciliationRepository,
    providers,
    schedule: {
      ...DEFAULT_RECONCILIATION_SCHEDULE,
      batchSize: environment.RECONCILIATION_BATCH_SIZE,
      leaseSeconds: environment.RECONCILIATION_LEASE_SECONDS,
      maximumAttempts: environment.RECONCILIATION_MAXIMUM_ATTEMPTS,
      strandedAfterSeconds: environment.RECONCILIATION_STRANDED_AFTER_SECONDS,
    },
    now: () => new Date(),
  };

  return {
    environment,
    logger,
    database,
    authentication,
    payments,
    reconciliation,
    reconciliationInsight: reconciliationRepository,
    async shutdown(): Promise<void> {
      // One pool, closed once. Database wraps it rather than owning a second.
      await database.close();
    },
  };
}
