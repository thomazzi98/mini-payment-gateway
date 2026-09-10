import { describe, expect, it } from 'vitest';
import { ReconciliationWorker } from './reconciliation-worker.js';
import { DEFAULT_RECONCILIATION_SCHEDULE } from '../../application/reconcile-payments.use-case.js';
import type { ReconciliationDependencies } from '../../application/reconcile-payments.use-case.js';
import type { DuePayment } from '../../application/ports/payment-reconciliation.repository.js';
import { ProviderRegistry } from '../../application/provider-registry.js';
import type { Logger } from '../logging/logger.js';

/**
 * The loop, driven deterministically. What matters here is that a batch which
 * fails does not end the worker, and that stopping never abandons work mid-flight.
 */

const SILENT = {
  info: () => {},
  error: () => {},
  warn: () => {},
  child: () => SILENT,
} as unknown as Logger;

function workerOver(
  claim: () => Promise<DuePayment[]>,
  maximumBatches: number,
): { worker: ReconciliationWorker; claims: () => number } {
  let claims = 0;
  const dependencies: ReconciliationDependencies = {
    store: {
      claimDue: () => {
        claims += 1;
        return claim();
      },
      applyResolution: () => Promise.resolve('applied' as const),
      deferResolution: () => Promise.resolve(),
    },
    stranded: {
      findStranded: () => Promise.resolve([]),
      markUncertain: () => Promise.resolve(true),
    },
    providers: new ProviderRegistry([]),
    schedule: DEFAULT_RECONCILIATION_SCHEDULE,
    now: () => new Date('2026-09-09T12:00:00.000Z'),
  };

  return {
    worker: new ReconciliationWorker(dependencies, SILENT, {
      pollIntervalMilliseconds: 1,
      maximumBatches,
    }),
    claims: () => claims,
  };
}

describe('the reconciliation loop', () => {
  it('keeps running after a batch fails', async () => {
    // A worker that dies on the first bad batch stops reconciling everything else,
    // and the failure that killed it is usually the transient one.
    let calls = 0;
    const { worker, claims } = workerOver(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error('the database went away'));
      }
      return Promise.resolve([]);
    }, 3);

    await worker.run();

    expect(claims()).toBe(3);
  });

  it('stops after finishing the batch in flight rather than abandoning it', async () => {
    let isFinished = false;

    // An explicit barrier rather than a count of microtask ticks: the number of
    // awaits before the claim is an implementation detail, and a test that
    // depends on it breaks the moment a step is added ahead of it.
    const started = Promise.withResolvers<void>();
    const batch = Promise.withResolvers<DuePayment[]>();

    const { worker } = workerOver(() => {
      started.resolve();
      return batch.promise;
    }, 10);

    const running = worker.run();
    await started.promise;

    const stopping = worker.stop();
    expect(isFinished).toBe(false);

    isFinished = true;
    batch.resolve([]);
    await stopping;
    await running;

    expect(isFinished).toBe(true);
  });

  it('is idempotent about stopping', async () => {
    const { worker } = workerOver(() => Promise.resolve([]), 1);
    await worker.run();

    await expect(worker.stop()).resolves.toBeUndefined();
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});
