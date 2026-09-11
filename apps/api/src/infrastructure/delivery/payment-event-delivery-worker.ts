import { deliverDuePaymentEvents } from '../../application/deliver-payment-events.use-case.js';
import type { DeliveryDependencies } from '../../application/deliver-payment-events.use-case.js';
import type { Logger } from '../logging/logger.js';

/**
 * Drives paid-event delivery on a loop until asked to stop.
 *
 * Same shape as the reconciliation worker, and run beside it in the same
 * process: both claim by lease, both survive a bad batch, and stopping either
 * loses no work because whatever was claimed becomes due again on its own.
 */

export interface DeliveryWorkerOptions {
  readonly pollIntervalMilliseconds: number;
  readonly maximumBatches?: number;
}

export class PaymentEventDeliveryWorker {
  #stopping = false;
  #batchInFlight: Promise<void> = Promise.resolve();

  public constructor(
    private readonly dependencies: DeliveryDependencies,
    private readonly logger: Logger,
    private readonly options: DeliveryWorkerOptions,
  ) {}

  public async runBatch(): Promise<void> {
    const startedAt = process.hrtime.bigint();
    try {
      const run = await deliverDuePaymentEvents(this.dependencies);
      if (run.failed > 0) {
        this.logger.error(
          { failed: run.failed },
          'events this batch could not act on; they are skipped, not lost',
        );
      }
      if (run.claimed === 0) {
        return;
      }

      for (const delivery of run.deliveries) {
        this.logger.info(
          {
            outcome: delivery.outcome.kind,
            eventId: delivery.eventId,
            organizationId: delivery.organizationId,
            eventType: delivery.eventType,
            attempts: delivery.attempts,
            ...('reference' in delivery.outcome && { reference: delivery.outcome.reference }),
            ...('reason' in delivery.outcome && { reason: delivery.outcome.reason }),
          },
          'payment event delivery outcome',
        );
      }

      this.logger.info(
        {
          claimed: run.claimed,
          durationMilliseconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        },
        'payment event delivery batch complete',
      );
    } catch (error) {
      this.logger.error({ err: error }, 'payment event delivery batch failed');
    }
  }

  public async run(): Promise<void> {
    let batches = 0;
    while (!this.#stopping) {
      this.#batchInFlight = this.runBatch();
      await this.#batchInFlight;

      batches += 1;
      if (this.options.maximumBatches !== undefined && batches >= this.options.maximumBatches) {
        return;
      }
      if (this.#stopping) {
        return;
      }
      await sleep(this.options.pollIntervalMilliseconds);
    }
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    await this.#batchInFlight;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds).unref();
  });
}
