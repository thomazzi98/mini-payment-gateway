import { describe, expect, it } from 'vitest';
import { EnvironmentValidationError, loadEnvironment } from './environment.js';

const MINIMUM_VALID = {
  DATABASE_URL: 'postgres://user:password@postgres:5432/payment_gateway',
  REDIS_URL: 'redis://redis:6379',
} satisfies NodeJS.ProcessEnv;

describe('loading configuration', () => {
  it('applies documented defaults when only the required values are present', () => {
    const environment = loadEnvironment(MINIMUM_VALID);

    expect(environment.NODE_ENV).toBe('development');
    expect(environment.LOG_LEVEL).toBe('info');
    expect(environment.HTTP_HOST).toBe('0.0.0.0');
    expect(environment.HTTP_PORT).toBe(3000);
  });

  it('coerces numeric values that arrive as strings, because every variable does', () => {
    const environment = loadEnvironment({ ...MINIMUM_VALID, HTTP_PORT: '4010' });
    expect(environment.HTTP_PORT).toBe(4010);
    expect(typeof environment.HTTP_PORT).toBe('number');
  });

  it('refuses to start when a required value is missing', () => {
    // The process must stop before it accepts a request. A missing DATABASE_URL
    // discovered halfway through handling a payment is far worse than a crash.
    expect(() => loadEnvironment({ REDIS_URL: 'redis://redis:6379' })).toThrow(
      EnvironmentValidationError,
    );
    expect(() => loadEnvironment({})).toThrow(EnvironmentValidationError);
  });

  it('names every offending variable, so one restart reveals all of them', () => {
    let message = '';
    try {
      loadEnvironment({});
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('REDIS_URL');
  });

  it('rejects values outside their permitted range', () => {
    expect(() => loadEnvironment({ ...MINIMUM_VALID, HTTP_PORT: '0' })).toThrow(
      EnvironmentValidationError,
    );
    expect(() => loadEnvironment({ ...MINIMUM_VALID, HTTP_PORT: '70000' })).toThrow(
      EnvironmentValidationError,
    );
    expect(() => loadEnvironment({ ...MINIMUM_VALID, HTTP_PORT: 'not-a-number' })).toThrow(
      EnvironmentValidationError,
    );
  });

  it('rejects an unknown value for a closed set', () => {
    expect(() => loadEnvironment({ ...MINIMUM_VALID, NODE_ENV: 'staging' })).toThrow(
      EnvironmentValidationError,
    );
    expect(() => loadEnvironment({ ...MINIMUM_VALID, LOG_LEVEL: 'verbose' })).toThrow(
      EnvironmentValidationError,
    );
  });

  it('does not repeat the value of a variable it rejects', () => {
    // DATABASE_URL carries a password. A validation error that echoes the value
    // puts that password into the startup log of every failed boot.
    let message = '';
    try {
      loadEnvironment({ DATABASE_URL: 'postgres://user:hunter2@host:5432/db', REDIS_URL: '' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).not.toContain('hunter2');
  });
});
