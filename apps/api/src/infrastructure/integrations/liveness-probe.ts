import { Agent, request } from 'undici';
import type { IntegrationProbe } from '../../interface/http/routes/health.routes.js';

/**
 * Asks another service's own liveness endpoint whether it is up. No credential
 * travels: a liveness probe is public by design, and the answer is the status
 * code and nothing in the body.
 */
export function livenessProbe(url: string, timeoutMilliseconds = 2000): IntegrationProbe {
  const agent = new Agent({
    connectTimeout: timeoutMilliseconds,
    headersTimeout: timeoutMilliseconds,
    bodyTimeout: timeoutMilliseconds,
  });
  return async () => {
    const response = await request(url, { method: 'GET', dispatcher: agent });
    await response.body.text();
    return response.statusCode >= 200 && response.statusCode < 300;
  };
}
