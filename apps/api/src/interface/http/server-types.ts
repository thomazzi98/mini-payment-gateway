import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Logger } from '../../infrastructure/logging/logger.js';

/**
 * Supplying a pino instance parameterizes Fastify's type by that logger, so the
 * default FastifyInstance no longer matches. Naming the shape once keeps every
 * route module agreeing with the server it is registered on.
 */
export type ApplicationServer = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  Logger
>;
