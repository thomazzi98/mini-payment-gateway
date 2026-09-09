import type { Environment } from '../../../domain/api-key/api-key.js';

/**
 * Appmax base URLs, frozen per environment and deliberately not configurable.
 *
 * If these came from configuration, a production deployment could be pointed at
 * sandbox — or worse, a sandbox one at production — by editing a variable. Making
 * them a constant keyed by the payment's own environment means the only way to
 * reach production is to be a production payment.
 */

export interface AppmaxEndpoints {
  readonly authenticationBaseUrl: string;
  readonly apiBaseUrl: string;
}

export const APPMAX_ENDPOINTS: Readonly<Record<Environment, AppmaxEndpoints>> = {
  SANDBOX: {
    authenticationBaseUrl: 'https://auth.sandboxappmax.com.br',
    apiBaseUrl: 'https://api.sandboxappmax.com.br',
  },
  PRODUCTION: {
    authenticationBaseUrl: 'https://auth.appmax.com.br',
    apiBaseUrl: 'https://api.appmax.com.br',
  },
};

export const APPMAX_TOKEN_PATH = '/oauth2/token';

/**
 * Timeouts are short and explicit.
 *
 * A request that hangs is not free: it holds a connection, and for order creation
 * it produces an ambiguous outcome that costs a reconciliation. Waiting longer
 * does not make the answer more likely, it only delays the point at which we
 * admit we do not know.
 */
export interface AppmaxTimeouts {
  readonly headersMilliseconds: number;
  readonly bodyMilliseconds: number;
  readonly connectMilliseconds: number;
}

export const DEFAULT_APPMAX_TIMEOUTS: AppmaxTimeouts = {
  headersMilliseconds: 15_000,
  bodyMilliseconds: 15_000,
  connectMilliseconds: 5000,
};
