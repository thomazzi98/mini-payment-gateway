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
import { ProviderWebhookRepository } from './infrastructure/persistence/provider-webhook.repository.js';
import { AppmaxWebhookReceiver } from './infrastructure/providers/appmax/appmax-webhook.js';
import type { WebhookRouteDependencies } from './interface/http/routes/webhook.routes.js';
import {
  AppmaxPixProvider,
  APPMAX_DESCRIPTOR,
} from './infrastructure/providers/appmax/appmax-provider.js';
import { AppmaxTokenCache } from './infrastructure/providers/appmax/appmax-token-cache.js';
import { UndiciAppmaxTransport } from './infrastructure/providers/appmax/appmax-http-transport.js';
import {
  CryptoPayProvider,
  cryptoPayDescriptor,
} from './infrastructure/providers/cryptopay/cryptopay-provider.js';
import { UndiciCryptoPayTransport } from './infrastructure/providers/cryptopay/cryptopay-http-transport.js';
import { CryptoPayWebhookReceiver } from './infrastructure/providers/cryptopay/cryptopay-webhook.js';
import { PaymentReadRepository } from './infrastructure/persistence/payment-read.repository.js';
import type { ReadPaymentDependencies } from './application/read-payment.use-case.js';
import { PaymentEventRepository } from './infrastructure/persistence/payment-event.repository.js';
import { WhatsAppNotificationPublisher } from './infrastructure/notifications/whatsapp-notification-publisher.js';
import { DEFAULT_DELIVERY_SCHEDULE } from './application/deliver-payment-events.use-case.js';
import type { DeliveryDependencies } from './application/deliver-payment-events.use-case.js';

export interface ApplicationContext {
  readonly environment: Environment;
  readonly logger: Logger;
  readonly database: Database;
  readonly authentication: AuthenticateApiKeyDependencies;
  readonly payments: CreatePaymentDependencies;
  readonly paymentReads: ReadPaymentDependencies;
  readonly reconciliation: ReconciliationDependencies;
  /**
   * Absent when no notification platform is configured. The worker then runs
   * reconciliation alone and says so; events stay pending rather than being
   * marked anything they are not.
   */
  readonly eventDelivery: DeliveryDependencies | undefined;
  readonly eventDeliveryInsight: PaymentEventRepository;
  /**
   * The reconciliation backlog, for the worker to report at startup. Separate
   * from the use case dependencies because it answers a question about the system
   * rather than participating in resolving a payment.
   */
  readonly reconciliationInsight: PaymentReconciliationRepository;
  readonly webhooks: WebhookRouteDependencies;
  readonly corsAllowedOrigins: readonly string[];
  shutdown(): Promise<void>;
}

function commaSeparated(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function withoutTrailingSlash(url: string): string {
  return url.endsWith('/') ? withoutTrailingSlash(url.slice(0, -1)) : url;
}

/**
 * Registers Appmax only when it is actually configured.
 *
 * A provider registered without credentials would fail every payment partway
 * through a call that was never going to work. Absent, the registry simply
 * offers nothing and the payment is refused with a reason that names the cause.
 */
function registerProviders(environment: Environment, logger: Logger): RegisteredProvider[] {
  return [...registerAppmax(environment, logger), ...registerCryptoPay(environment, logger)];
}

function registerAppmax(environment: Environment, logger: Logger): RegisteredProvider[] {
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
 * Registers CryptoPay only when it is configured well enough to be called and to
 * call back. A callback URL is part of that: a crypto payment without one would
 * be confirmed only by polling, which is correct but slow, and forgetting it is
 * the misconfiguration worth refusing at startup.
 */
function registerCryptoPay(environment: Environment, logger: Logger): RegisteredProvider[] {
  if (environment.CRYPTOPAY_BASE_URL === '' || environment.CRYPTOPAY_API_KEY === '') {
    logger.warn(
      { provider: 'cryptopay' },
      'cryptopay is not configured; no provider is registered for crypto',
    );
    return [];
  }
  if (environment.CRYPTOPAY_CALLBACK_URL === '') {
    throw new Error(
      'CRYPTOPAY_CALLBACK_URL is required when CryptoPay is configured: it is where CryptoPay delivers signed notifications.',
    );
  }

  const descriptor = cryptoPayDescriptor({
    network: environment.CRYPTOPAY_NETWORK,
    currencies: commaSeparated(environment.CRYPTOPAY_CURRENCIES),
  });
  const transport = new UndiciCryptoPayTransport(
    withoutTrailingSlash(environment.CRYPTOPAY_BASE_URL),
    new Secret(environment.CRYPTOPAY_API_KEY),
    logger,
  );

  logger.info(
    {
      provider: 'cryptopay',
      environment: environment.CRYPTOPAY_ENVIRONMENT,
      network: environment.CRYPTOPAY_NETWORK,
      currencies: descriptor.supportedCurrencies,
    },
    'cryptopay registered for crypto in one environment',
  );

  return [
    {
      descriptor,
      environment: environment.CRYPTOPAY_ENVIRONMENT,
      crypto: new CryptoPayProvider(
        descriptor,
        environment.CRYPTOPAY_NETWORK,
        environment.CRYPTOPAY_CALLBACK_URL,
        transport,
      ),
      priority: 1,
    },
  ];
}

/**
 * The paid event is handed on only when there is somewhere to hand it. Without
 * a platform configured the outbox is left alone, which is the honest state:
 * pending, and visible as pending to anyone who reads the payment.
 */
function buildEventDelivery(
  environment: Environment,
  logger: Logger,
  store: PaymentEventRepository,
): DeliveryDependencies | undefined {
  if (
    environment.WHATSAPP_NOTIFICATION_BASE_URL === '' ||
    environment.WHATSAPP_NOTIFICATION_API_KEY === ''
  ) {
    logger.warn(
      { channel: 'whatsapp' },
      'the whatsapp notification platform is not configured; paid events will not be delivered',
    );
    return undefined;
  }
  return {
    store,
    notifier: new WhatsAppNotificationPublisher(
      withoutTrailingSlash(environment.WHATSAPP_NOTIFICATION_BASE_URL),
      new Secret(environment.WHATSAPP_NOTIFICATION_API_KEY),
      logger,
    ),
    schedule: {
      ...DEFAULT_DELIVERY_SCHEDULE,
      maximumAttempts: environment.EVENT_DELIVERY_MAXIMUM_ATTEMPTS,
    },
    now: () => new Date(),
    onEventError: (eventId, error) => {
      logger.error({ err: error, eventId }, 'event delivery could not act on an event');
    },
  };
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

  const webhookStore = new ProviderWebhookRepository(pool);
  const webhooks: WebhookRouteDependencies = {
    appmax: {
      receiver: new AppmaxWebhookReceiver(),
      store: webhookStore,
    },
    cryptopay: {
      receiver: new CryptoPayWebhookReceiver(
        commaSeparated(environment.CRYPTOPAY_WEBHOOK_SECRETS).map((secret) => new Secret(secret)),
      ),
      store: webhookStore,
    },
    pathSecret: new Secret(environment.WEBHOOK_PATH_SECRET),
  };

  const paymentReads: ReadPaymentDependencies = { store: new PaymentReadRepository(pool) };
  const eventRepository = new PaymentEventRepository(pool);

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
    onPaymentError: (paymentId, error) => {
      logger.error({ err: error, paymentId }, 'reconciliation could not act on a payment');
    },
  };

  return {
    environment,
    logger,
    database,
    authentication,
    payments,
    paymentReads,
    reconciliation,
    reconciliationInsight: reconciliationRepository,
    eventDelivery: buildEventDelivery(environment, logger, eventRepository),
    eventDeliveryInsight: eventRepository,
    webhooks,
    corsAllowedOrigins: commaSeparated(environment.HTTP_CORS_ALLOWED_ORIGINS),
    async shutdown(): Promise<void> {
      // One pool, closed once. Database wraps it rather than owning a second.
      await database.close();
    },
  };
}
