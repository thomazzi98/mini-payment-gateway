import { reconcileDuePayments } from '../../application/reconcile-payments.use-case.js';
import type {
  PaymentResolution,
  ReconciliationDependencies,
} from '../../application/reconcile-payments.use-case.js';
import type { Logger } from '../logging/logger.js';

/**
 * Drives reconciliation on a loop until asked to stop.
 *
 * A class rather than a script so the loop can be driven deterministically in a
 * test: restart safety is a property worth proving, and proving it against a
 * module that starts itself on import is not possible.
 */

export interface WorkerOptions {
  readonly pollIntervalMilliseconds: number;
  /**
   * Bounds the loop. Left undefined it runs until stopped, which is what the
   * process does; a test gives a number so the loop terminates on its own.
   */
  readonly maximumBatches?: number;
}

export class ReconciliationWorker {
  #stopping = false;
  #batchInFlight: Promise<void> = Promise.resolve();

  public constructor(
    private readonly dependencies: ReconciliationDependencies,
    private readonly logger: Logger,
    private readonly options: WorkerOptions,
  ) {}

  /**
   * One batch. Errors are logged and swallowed: a bad batch must not end the
   * worker, and whatever it claimed is leased rather than locked, so it becomes
   * due again on its own with nothing stranded.
   */
  public async runBatch(): Promise<void> {
    const startedAt = process.hrtime.bigint();
    try {
      const run = await reconcileDuePayments(this.dependencies);
      if (run.recovered > 0) {
        this.logger.warn(
          { recovered: run.recovered },
          'payments abandoned mid-flight were moved to unknown for reconciliation',
        );
      }
      if (run.claimed === 0) {
        return;
      }

      // One line per payment, carrying what an operator needs to follow it
      // through the logs and into the database. A provider reference is the
      // provider's own identifier for the order, never a credential.
      for (const resolution of run.resolutions) {
        this.logger.info(
          {
            outcome: resolution.kind,
            paymentId: resolution.paymentId,
            organizationId: resolution.organizationId,
            environment: resolution.environment,
            paymentAttemptId: resolution.attemptId,
            providerCode: resolution.providerCode,
            providerReference: resolution.providerReference,
            reconciliationAttempts: resolution.attempts,
            ...('toStatus' in resolution && { toStatus: resolution.toStatus }),
            ...('trigger' in resolution && { trigger: resolution.trigger }),
            ...('reason' in resolution && { reason: resolution.reason }),
          },
          'payment reconciliation outcome',
        );
      }

      this.logger.info(
        {
          claimed: run.claimed,
          ...countByKind(run.resolutions),
          durationMilliseconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        },
        'reconciliation batch complete',
      );
    } catch (error) {
      this.logger.error({ err: error }, 'reconciliation batch failed');
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

  /**
   * Lets the batch in flight finish rather than abandoning it mid-resolution.
   * Anything it has not resolved is still leased and becomes due again on its
   * own, so stopping loses no work.
   */
  public async stop(): Promise<void> {
    this.#stopping = true;
    await this.#batchInFlight;
  }
}

function countByKind(resolutions: readonly PaymentResolution[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const resolution of resolutions) {
    counts[resolution.kind] = (counts[resolution.kind] ?? 0) + 1;
  }
  return counts;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    // Nothing here should hold the process open past a shutdown signal.
    setTimeout(resolve, milliseconds).unref();
  });
}
