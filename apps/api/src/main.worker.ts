import { buildApplicationContext } from './composition-root.js';
import { ReconciliationWorker } from './infrastructure/reconciliation/reconciliation-worker.js';

/**
 * The reconciliation worker process.
 *
 * A payment reaches `unknown` when a provider call produced no usable answer, and
 * nothing else in the system can move it out again. This is what makes `unknown` a
 * state payments pass through rather than one they end in.
 *
 * Several of these may run at once: work is claimed by lease, so none blocks
 * another, and one that dies mid-inquiry delays its claimed payments by a single
 * lease and loses nothing.
 */

const context = buildApplicationContext();
const logger = context.logger.child({ component: 'reconciliation-worker' });

const worker = new ReconciliationWorker(context.reconciliation, logger, {
  pollIntervalMilliseconds: context.environment.RECONCILIATION_POLL_MILLISECONDS,
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'reconciliation worker stopping');
    void worker
      .stop()
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

await worker.run();
