import { apiError, internalError } from './errors.js';
import type { ApplicationServer } from './server-types.js';

/**
 * Makes every failure leave in the documented envelope.
 *
 * Registered separately from the routes so the tests that assert this contract
 * exercise the same code the server runs. Asserting it against a second,
 * test-local handler would prove only that the test agrees with itself.
 */
export function registerErrorHandling(server: ApplicationServer): void {
  /**
   * Without this, an unhandled throw returns Fastify's default 500 carrying the
   * exception's own message — a driver error naming a constraint, or a provider
   * message. Both describe internals to whoever asked. The error is logged in
   * full; the caller gets the request id to quote.
   */
  server.setErrorHandler((error, request, reply) => {
    const status = statusCodeOf(error);

    // Framework-generated client errors: a malformed JSON body, an unsupported
    // media type, a body over the limit. Real, but the message is not ours to
    // vouch for, so it is replaced rather than forwarded.
    if (status >= 400 && status < 500) {
      request.log.info({ err: error, statusCode: status }, 'request refused');
      const refusal = apiError({
        httpStatus: status,
        type: 'invalid_request_error',
        code: 'invalid_request',
        message: 'The request could not be read.',
        requestId: request.id,
      });
      return reply.code(refusal.httpStatus).send(refusal.body);
    }

    request.log.error({ err: error }, 'unhandled error while serving a request');
    const failure = internalError(request.id);
    return reply.code(failure.httpStatus).send(failure.body);
  });

  // Otherwise an unknown path answers in Fastify's own envelope, so a merchant
  // discovers a second error shape the moment they mistype a URL.
  server.setNotFoundHandler((request, reply) => {
    const missing = apiError({
      httpStatus: 404,
      type: 'invalid_request_error',
      code: 'not_found',
      message: 'No such endpoint.',
      requestId: request.id,
    });
    return reply.code(missing.httpStatus).send(missing.body);
  });
}

/**
 * Fastify tags the errors it raises itself — a malformed body, an oversized one —
 * with the status it intended. Anything without one is ours and is a 500.
 */
function statusCodeOf(error: unknown): number {
  if (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
  ) {
    return error.statusCode;
  }
  return 500;
}
