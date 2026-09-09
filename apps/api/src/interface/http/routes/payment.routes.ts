import { z } from 'zod';
import { authenticateApiKey } from '../../../application/authenticate-api-key.js';
import type { AuthenticateApiKeyDependencies } from '../../../application/authenticate-api-key.js';
import { createPayment } from '../../../application/create-payment.use-case.js';
import type {
  CreatePaymentDependencies,
  CreatePaymentOutcome,
} from '../../../application/create-payment.use-case.js';
import { missingScopes } from '../../../domain/api-key/api-key.js';
import type { ApiKeyPrincipal } from '../../../domain/api-key/api-key.js';
import { apiError, authenticationRefused } from '../errors.js';
import type { ApiError } from '../errors.js';
import type { ApplicationServer } from '../server-types.js';

/**
 * The HTTP layer, and nothing more.
 *
 * It authenticates, validates the request shape, calls one use case, and turns
 * the outcome into a status code. Every decision about money is made below this
 * file; the route only decides how to say it.
 */

const BEARER_PREFIX = 'Bearer ';

/**
 * Matches the idempotency_records column, so the edge refuses what the database
 * would refuse rather than letting it become a 500.
 */
const MAXIMUM_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Amounts arrive as integer minor units and are refused otherwise.
 *
 * A caller sending 19.99 believes this API takes major units, and silently
 * rounding that charges the wrong amount. `z.int()` rejects a fractional number
 * rather than truncating it.
 */
const paymentRequestSchema = z
  .object({
    amount: z.int().positive().max(100_000_000),
    currency: z.literal('BRL'),
    paymentMethod: z.literal('pix'),
    // Trimmed before it is measured and before it is stored. Measuring the raw
    // string let "   " through as a valid reference, which the database then
    // refused, and let whitespace variants of one reference each hold their own
    // live payment against the uniqueness index.
    reference: z.string().trim().min(1).max(255),
    description: z.string().trim().min(1).max(255),
    customer: z
      .object({
        firstName: z.string().min(1).max(100),
        lastName: z.string().min(1).max(100),
        email: z.string().email().max(200),
        phone: z.string().min(8).max(20),
        documentNumber: z.string().min(11).max(14),
      })
      .strict(),
  })
  // Unknown keys are an error, never stripped. A stripped key is a silently
  // ignored instruction, and a merchant who sends `ammount` deserves to be told.
  .strict();

export interface PaymentRouteDependencies {
  readonly authentication: AuthenticateApiKeyDependencies;
  readonly payments: CreatePaymentDependencies;
}

interface Authenticated {
  readonly principal: ApiKeyPrincipal;
}

export function registerPaymentRoutes(
  server: ApplicationServer,
  dependencies: PaymentRouteDependencies,
): void {
  server.post('/v1/payments', async (request, reply) => {
    const requestId = request.id;

    const authenticated = await authenticate(
      request.headers.authorization,
      requestId,
      dependencies,
    );
    if ('httpStatus' in authenticated) {
      return reply.code(authenticated.httpStatus).send(authenticated.body);
    }

    const missing = missingScopes(authenticated.principal, ['payments:write']);
    if (missing.length > 0) {
      return reply.code(403).send(
        apiError({
          httpStatus: 403,
          type: 'authorization_error',
          code: 'insufficient_scope',
          message: `This API key is missing the required scope: ${missing.join(', ')}.`,
          requestId,
        }).body,
      );
    }

    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
      return reply.code(400).send(
        apiError({
          httpStatus: 400,
          type: 'invalid_request_error',
          code: 'missing_idempotency_key',
          message: 'An Idempotency-Key header is required to create a payment.',
          requestId,
        }).body,
      );
    }
    // The column is bounded at 255. Unchecked, a longer key reached the database
    // and came back as a constraint violation, which the caller saw as a 500 for
    // what is plainly their own input.
    if (idempotencyKey.trim().length > MAXIMUM_IDEMPOTENCY_KEY_LENGTH) {
      return reply.code(400).send(
        apiError({
          httpStatus: 400,
          type: 'invalid_request_error',
          code: 'invalid_request',
          message: `An Idempotency-Key may be at most ${MAXIMUM_IDEMPOTENCY_KEY_LENGTH} characters.`,
          requestId,
          param: 'Idempotency-Key',
        }).body,
      );
    }

    const parsed = paymentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      return reply.code(422).send(
        apiError({
          httpStatus: 422,
          type: 'invalid_request_error',
          code: 'invalid_request',
          message: firstIssue?.message ?? 'The request body is not valid.',
          requestId,
          ...(firstIssue !== undefined && { param: firstIssue.path.join('.') }),
        }).body,
      );
    }

    const outcome = await createPayment(
      {
        organizationId: authenticated.principal.organizationId,
        // Taken from the key, never from the body. A caller cannot ask for
        // production by saying so.
        environment: authenticated.principal.environment,
        merchantReference: parsed.data.reference,
        currency: parsed.data.currency,
        expectedAmountMinor: BigInt(parsed.data.amount),
        description: parsed.data.description,
        customer: { ...parsed.data.customer, ipAddress: request.ip },
        idempotencyKey: idempotencyKey.trim(),
        requestPath: '/v1/payments',
        requestBody: request.body,
      },
      dependencies.payments,
    );

    const rendered = renderOutcome(outcome, requestId);
    return reply.code(rendered.httpStatus).send(rendered.body);
  });
}

async function authenticate(
  authorizationHeader: string | undefined,
  requestId: string,
  dependencies: PaymentRouteDependencies,
): Promise<Authenticated | ApiError> {
  if (authorizationHeader === undefined || !authorizationHeader.startsWith(BEARER_PREFIX)) {
    return authenticationRefused(requestId);
  }

  const result = await authenticateApiKey(
    authorizationHeader.slice(BEARER_PREFIX.length),
    dependencies.authentication,
  );

  if (result.outcome !== 'authenticated') {
    return authenticationRefused(requestId);
  }
  return { principal: result.principal };
}

interface RenderedOutcome {
  readonly httpStatus: number;
  readonly body: unknown;
}

/**
 * Every outcome that produced a payment carries the status it was stored with, so
 * a replay of it answers identically. The route does not re-derive that number;
 * re-deriving it is how the stored status and the live one drift apart.
 */
function renderOutcome(outcome: CreatePaymentOutcome, requestId: string): RenderedOutcome {
  if (outcome.kind === 'replayed') {
    return { httpStatus: outcome.responseStatus, body: outcome.responseBody };
  }
  // Narrowed on the payment itself rather than on a list of kinds: every outcome
  // that carries one also carries the status it was stored with, so a new kind
  // cannot be added that returns a payment without a matching stored status.
  if ('payment' in outcome) {
    return { httpStatus: outcome.responseStatus, body: outcome.payment };
  }

  const failure = errorFor(outcome, requestId);
  return { httpStatus: failure.httpStatus, body: failure.body };
}

function errorFor(outcome: CreatePaymentOutcome, requestId: string): ApiError {
  if (outcome.kind === 'idempotency_conflict') {
    return apiError({
      httpStatus: 422,
      type: 'invalid_request_error',
      code: 'idempotency_key_reuse',
      message: 'This idempotency key was already used with a different request.',
      requestId,
    });
  }
  if (outcome.kind === 'in_flight') {
    return apiError({
      httpStatus: 409,
      type: 'conflict_error',
      code: 'idempotency_key_in_flight',
      message: 'A request with this idempotency key is still being processed. Retry shortly.',
      requestId,
      retryable: true,
    });
  }
  if (outcome.kind === 'duplicate_merchant_reference') {
    return apiError({
      httpStatus: 409,
      type: 'conflict_error',
      code: 'duplicate_merchant_reference',
      message: 'A live payment already exists for this reference.',
      requestId,
    });
  }
  return apiError({
    httpStatus: 500,
    type: 'api_error',
    code: 'internal_error',
    message: 'The payment could not be created.',
    requestId,
  });
}
