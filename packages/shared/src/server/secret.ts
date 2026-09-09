const REDACTED = '[redacted]';

/**
 * A string that refuses to reveal itself by accident.
 *
 * Every route by which a value normally reaches a log — string coercion, template
 * interpolation, JSON.stringify, console.log, pino's serializer, util.inspect — is
 * overridden to yield "[redacted]". Reading the real value requires calling
 * expose(), which is greppable and reviewable in a way that `${secret}` is not.
 *
 * This is the difference between "we agreed not to log secrets" and "logging a
 * secret requires deliberately writing the word expose".
 */
export class Secret<Value extends string = string> {
  readonly #value: Value;

  public constructor(value: Value) {
    this.#value = value;
  }

  public expose(): Value {
    return this.#value;
  }

  public toString(): string {
    return REDACTED;
  }

  public toJSON(): string {
    return REDACTED;
  }

  public [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  public [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }

  public get [Symbol.toStringTag](): string {
    return 'Secret';
  }
}

export function isSecret(candidate: unknown): candidate is Secret {
  return candidate instanceof Secret;
}
