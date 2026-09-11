import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Database } from '../../../infrastructure/persistence/database.js';
import { registerHealthRoutes } from './health.routes.js';
import type { ApplicationServer } from '../server-types.js';

function databaseThatIs(isReachable: boolean): Database {
  return {
    checkHealth: () => Promise.resolve({ isReachable, durationMilliseconds: 1.234 }),
  } as unknown as Database;
}

interface Readiness {
  readonly status: string;
  readonly checks: {
    readonly database: { readonly status: string };
    readonly integrations: Record<string, { readonly status: string; readonly required: boolean }>;
  };
}

async function ready(
  isReachable: boolean,
  integrations?: Parameters<typeof registerHealthRoutes>[1]['integrations'],
) {
  const server = Fastify() as unknown as ApplicationServer;
  registerHealthRoutes(server, {
    database: databaseThatIs(isReachable),
    ...(integrations !== undefined && { integrations }),
  });
  const response = await server.inject({ method: 'GET', url: '/ready' });
  return { status: response.statusCode, body: response.json<Readiness>() };
}

describe('readiness', () => {
  it('is decided by the database alone', async () => {
    const up = await ready(true, { cryptopay: () => Promise.resolve(false) });
    expect(up.status).toBe(200);
    expect(up.body.status).toBe('ready');

    const down = await ready(false, { cryptopay: () => Promise.resolve(true) });
    expect(down.status).toBe(503);
    expect(down.body.status).toBe('not_ready');
  });

  it('reports each integration as up, down or not configured, never as required', async () => {
    const result = await ready(true, {
      cryptopay: () => Promise.resolve(true),
      whatsappNotification: () => Promise.reject(new Error('refused')),
      appmax: undefined,
    });

    expect(result.body.checks.integrations).toEqual({
      cryptopay: { status: 'up', required: false },
      whatsappNotification: { status: 'down', required: false },
      appmax: { status: 'not_configured', required: false },
    });
  });

  it('reports no integrations when none are given', async () => {
    const result = await ready(true);
    expect(result.body.checks.integrations).toEqual({});
  });
});
