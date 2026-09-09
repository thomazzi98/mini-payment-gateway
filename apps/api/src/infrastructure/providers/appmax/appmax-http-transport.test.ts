import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Secret } from '@gateway/shared/server';
import { afterEach, describe, expect, it } from 'vitest';
import { AppmaxAuthenticationError, UndiciAppmaxTransport } from './appmax-http-transport.js';
import type { AppmaxCredentials, TransportLogger } from './appmax-http-transport.js';
import type { AppmaxEndpoints } from './appmax-endpoints.js';

/**
 * These run over real HTTP against a local server rather than through a mocked
 * dispatcher. The behaviour under test is undici's — how it reports a body
 * timeout, a refused connection, a reset — and a mock would only prove that the
 * mock behaves as written.
 */

interface Handled {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

interface LocalProvider {
  readonly endpoints: AppmaxEndpoints;
  readonly received: Handled[];
  close(): Promise<void>;
}

type Responder = (received: Handled) => {
  status: number;
  body?: string;
  contentType?: string;
  /**
   * Hold the response open, so a body timeout can be observed.
   */
  hang?: boolean;
};

const openServers: Server[] = [];

async function startProvider(respond: Responder): Promise<LocalProvider> {
  const received: Handled[] = [];

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const handled: Handled = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      received.push(handled);

      const reply = respond(handled);
      if (reply.hang === true) {
        response.writeHead(reply.status, { 'content-type': 'application/json' });
        // Deliberately never ended.
        return;
      }
      response.writeHead(reply.status, {
        'content-type': reply.contentType ?? 'application/json',
      });
      response.end(reply.body ?? '{}');
    });
  });

  openServers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  return {
    endpoints: { authenticationBaseUrl: base, apiBaseUrl: base },
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function recordingLogger(): TransportLogger & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    debug: (details, message) => {
      lines.push(`${message} ${JSON.stringify(details)}`);
    },
    warn: (details, message) => {
      lines.push(`${message} ${JSON.stringify(details)}`);
    },
  };
}

const CREDENTIALS: AppmaxCredentials = {
  clientId: 'client-identifier',
  clientSecret: new Secret('a-client-secret-that-must-never-be-logged'),
};

const IMPATIENT = { headersMilliseconds: 300, bodyMilliseconds: 300, connectMilliseconds: 300 };

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      async (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function transportFor(respond: Responder) {
  const provider = await startProvider(respond);
  const logger = recordingLogger();
  return {
    provider,
    logger,
    transport: new UndiciAppmaxTransport(
      'SANDBOX',
      CREDENTIALS,
      logger,
      IMPATIENT,
      provider.endpoints,
    ),
  };
}

describe('production endpoints are frozen', () => {
  it('refuses an endpoint override for production', () => {
    // The only route to a live merchant account is the frozen map. No injected
    // value and no configuration mistake may redirect production traffic.
    expect(
      () =>
        new UndiciAppmaxTransport('PRODUCTION', CREDENTIALS, recordingLogger(), IMPATIENT, {
          authenticationBaseUrl: 'http://127.0.0.1:1',
          apiBaseUrl: 'http://127.0.0.1:1',
        }),
    ).toThrow(/frozen/);
  });

  it('allows one for sandbox, which is how these tests reach a local server', () => {
    expect(
      () =>
        new UndiciAppmaxTransport('SANDBOX', CREDENTIALS, recordingLogger(), IMPATIENT, {
          authenticationBaseUrl: 'http://127.0.0.1:1',
          apiBaseUrl: 'http://127.0.0.1:1',
        }),
    ).not.toThrow();
  });
});

describe('acquiring a token', () => {
  it('posts form-encoded client credentials and reads the token back', async () => {
    const provider = await startProvider(() => ({
      status: 200,
      body: JSON.stringify({
        access_token: 'issued-token',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    }));
    const transport = new UndiciAppmaxTransport(
      'SANDBOX',
      CREDENTIALS,
      recordingLogger(),
      IMPATIENT,
      provider.endpoints,
    );

    const token = await transport.fetchToken();

    expect(token.accessToken.expose()).toBe('issued-token');
    expect(token.expiresInSeconds).toBe(3600);

    const call = provider.received[0];
    expect(call?.url).toBe('/oauth2/token');
    expect(call?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(call?.body).toContain('grant_type=client_credentials');
    expect(call?.body).toContain('client_id=client-identifier');
  });

  it('reports a rejected credential as an authentication failure', async () => {
    const provider = await startProvider(() => ({
      status: 401,
      body: JSON.stringify({ error: 'invalid_client' }),
    }));
    const transport = new UndiciAppmaxTransport(
      'SANDBOX',
      CREDENTIALS,
      recordingLogger(),
      IMPATIENT,
      provider.endpoints,
    );

    await expect(transport.fetchToken()).rejects.toThrow(AppmaxAuthenticationError);
  });

  it('refuses a token response with no usable token rather than proceeding', async () => {
    const provider = await startProvider(() => ({ status: 200, body: JSON.stringify({}) }));
    const transport = new UndiciAppmaxTransport(
      'SANDBOX',
      CREDENTIALS,
      recordingLogger(),
      IMPATIENT,
      provider.endpoints,
    );

    await expect(transport.fetchToken()).rejects.toThrow(/without a usable access token/);
  });

  it('treats an implausible lifetime as immediate expiry rather than as forever', async () => {
    const provider = await startProvider(() => ({
      status: 200,
      body: JSON.stringify({ access_token: 'issued-token', expires_in: -1 }),
    }));
    const transport = new UndiciAppmaxTransport(
      'SANDBOX',
      CREDENTIALS,
      recordingLogger(),
      IMPATIENT,
      provider.endpoints,
    );

    const token = await transport.fetchToken();
    expect(token.expiresInSeconds).toBe(0);
  });

  it('never writes the client secret into a log line', async () => {
    const provider = await startProvider(() => ({ status: 401, body: '{}' }));
    const logger = recordingLogger();
    const transport = new UndiciAppmaxTransport(
      'SANDBOX',
      CREDENTIALS,
      logger,
      IMPATIENT,
      provider.endpoints,
    );

    await expect(transport.fetchToken()).rejects.toThrow();

    expect(logger.lines.join('\n')).not.toContain(CREDENTIALS.clientSecret.expose());
    expect(logger.lines.length).toBeGreaterThan(0);
  });
});

describe('making an authenticated request', () => {
  it('sends the bearer token and parses a successful response', async () => {
    const { transport, provider } = await transportFor(() => ({
      status: 200,
      body: JSON.stringify({ data: { order: { id: 3531 } } }),
    }));

    const response = await transport.request({
      method: 'POST',
      path: '/v1/orders',
      accessToken: new Secret('the-access-token'),
      body: { customer_id: 1 },
    });

    expect(response.transport).toEqual({ kind: 'response', httpStatus: 200 });
    expect(response.body).toEqual({ data: { order: { id: 3531 } } });
    expect(provider.received[0]?.headers['authorization']).toBe('Bearer the-access-token');
    expect(provider.received[0]?.body).toBe('{"customer_id":1}');
  });

  it('sends no content-type or body for a GET', async () => {
    const { transport, provider } = await transportFor(() => ({ status: 200, body: '{}' }));

    await transport.request({
      method: 'GET',
      path: '/v1/orders/3531',
      accessToken: new Secret('the-access-token'),
    });

    expect(provider.received[0]?.method).toBe('GET');
    expect(provider.received[0]?.body).toBe('');
  });

  it.each([401, 403, 400, 422, 429, 500, 503])(
    'reports HTTP %i without throwing',
    async (status) => {
      // Throwing here would collapse "Appmax said no" and "we do not know what
      // Appmax did" into one thing, and every downstream decision depends on
      // telling them apart.
      const { transport } = await transportFor(() => ({
        status,
        body: JSON.stringify({ message: 'refused' }),
      }));

      const response = await transport.request({
        method: 'POST',
        path: '/v1/orders',
        accessToken: new Secret('the-access-token'),
        body: {},
      });

      expect(response.transport).toEqual({ kind: 'response', httpStatus: status });
    },
  );

  it('reports a body that will not parse as malformed rather than as a success', async () => {
    const { transport } = await transportFor(() => ({
      status: 200,
      body: '{"data": {"order"',
    }));

    const response = await transport.request({
      method: 'GET',
      path: '/v1/orders/1',
      accessToken: new Secret('the-access-token'),
    });

    expect(response.transport.kind).toBe('malformed_body');
    expect(response.body).toBeUndefined();
  });

  it('reports a body timeout as a timeout, which is an ambiguous outcome', async () => {
    // The server accepts the request and never answers. Appmax may well have
    // acted on it, so this must never be reported as a failure.
    const { transport } = await transportFor(() => ({ status: 200, hang: true }));

    const response = await transport.request({
      method: 'POST',
      path: '/v1/orders',
      accessToken: new Secret('the-access-token'),
      body: {},
    });

    expect(response.transport.kind).toBe('timeout');
  });

  it('reports a refused connection as never delivered, which is safe to retry', async () => {
    const logger = recordingLogger();
    const transport = new UndiciAppmaxTransport('SANDBOX', CREDENTIALS, logger, IMPATIENT, {
      // Port 1 on loopback refuses immediately.
      authenticationBaseUrl: 'http://127.0.0.1:1',
      apiBaseUrl: 'http://127.0.0.1:1',
    });

    const response = await transport.request({
      method: 'POST',
      path: '/v1/orders',
      accessToken: new Secret('the-access-token'),
      body: {},
    });

    expect(response.transport).toEqual({
      kind: 'connection_error',
      requestDefinitelyNotDelivered: true,
    });
  });

  it('never writes the access token into a log line', async () => {
    const { transport, logger } = await transportFor(() => ({
      status: 422,
      body: JSON.stringify({ errors: { document_number: ['is invalid'] } }),
    }));

    await transport.request({
      method: 'POST',
      path: '/v1/payments/pix',
      accessToken: new Secret('a-token-that-must-never-be-logged'),
      body: { payment_data: { pix: { document_number: '25226493029' } } },
    });

    const written = logger.lines.join('\n');
    expect(written).not.toContain('a-token-that-must-never-be-logged');
    expect(written).not.toContain('Bearer');
  });

  it('logs which fields Appmax rejected but never their values', async () => {
    // A rejected document_number tells an operator what to fix; the number itself
    // is the customer's and has no business in a log.
    const { transport, logger } = await transportFor(() => ({
      status: 422,
      body: JSON.stringify({ errors: { document_number: ['is invalid'] } }),
    }));

    await transport.request({
      method: 'POST',
      path: '/v1/payments/pix',
      accessToken: new Secret('the-access-token'),
      body: { payment_data: { pix: { document_number: '25226493029' } } },
    });

    const written = logger.lines.join('\n');
    expect(written).toContain('document_number');
    expect(written).not.toContain('25226493029');
  });
});
