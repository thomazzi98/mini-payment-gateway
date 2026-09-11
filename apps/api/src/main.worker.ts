import { buildApplicationContext } from './composition-root.js';
import { PaymentEventDeliveryWorker } from './infrastructure/delivery/payment-event-delivery-worker.js';
import { ReconciliationWorker } from './infrastructure/reconciliation/reconciliation-worker.js';

/**
 * The background worker process: reconciliation, and delivery of the paid event.
 *
 * A payment reaches `unknown` when a provider call produced no usable answer, and
 * nothing else in the system can move it out again. This is what makes `unknown` a
 * state payments pass through rather than one they end in. A payment that reaches
 * `paid` writes its event in the same transaction, and this process is what hands
 * that event on.
 *
 * Several of these may run at once: work is claimed by lease, so none blocks
 * another, and one that dies mid-inquiry delays its claimed payments by a single
 * lease and loses nothing. The same holds for events.
 */

const context = buildApplicationContext();
const logger = context.logger.child({ component: 'reconciliation-worker' });

const worker = new ReconciliationWorker(context.reconciliation, logger, {
  pollIntervalMilliseconds: context.environment.RECONCILIATION_POLL_MILLISECONDS,
});

const deliveryLogger = context.logger.child({ component: 'event-delivery-worker' });
const delivery =
  context.eventDelivery === undefined
    ? undefined
    : new PaymentEventDeliveryWorker(context.eventDelivery, deliveryLogger, {
        pollIntervalMilliseconds: context.environment.EVENT_DELIVERY_POLL_MILLISECONDS,
      });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'worker stopping');
    void Promise.all([worker.stop(), delivery?.stop()])
      .then(() => context.shutdown())
      .then(() => {
        process.exit(0);
      });
  });
}

const awaitingOperator = await context.reconciliationInsight.countAwaitingOperator();
logger.info(
  {
    pollIntervalMilliseconds: context.environment.RECONCILIATION_POLL_MILLISECONDS,
    // Uncertain payments reconciliation has stopped scheduling. If this grows,
    // inquiries are failing for a reason nobody has looked at.
    awaitingOperator,
  },
  'reconciliation worker started',
);

if (delivery === undefined) {
  deliveryLogger.warn(
    'paid events are not being delivered: no notification platform is configured',
  );
}
if (delivery !== undefined) {
  const abandoned = await context.eventDeliveryInsight.countAbandoned();
  deliveryLogger.info(
    {
      pollIntervalMilliseconds: context.environment.EVENT_DELIVERY_POLL_MILLISECONDS,
      // Events delivery has given up on. If this grows, the notification
      // platform is refusing or unreachable for a reason nobody has looked at.
      abandoned,
    },
    'event delivery worker started',
  );
}

await Promise.all([worker.run(), delivery?.run()]);
