import { describe, expect, it } from 'vitest';
import {
  EnvironmentValidationError,
  loadDatabaseEnvironment,
  loadEnvironment,
} from './environment.js';

const MINIMUM_VALID = {
  DATABASE_URL: 'postgres://user:password@postgres:5432/payment_gateway',
  REDIS_URL: 'redis://redis:6379',
  // Long enough to satisfy the schema and obviously not a real pepper.
  API_KEY_PEPPER: 'a-pepper-for-tests-only-not-a-real-one',
  WEBHOOK_PATH_SECRET: 'a-webhook-path-secret-for-tests',
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
    expect(message).toContain('API_KEY_PEPPER');
    expect(message).toContain('WEBHOOK_PATH_SECRET');
  });

  it('refuses a webhook path secret short enough to guess', () => {
    // The path is the only thing bounding who can reach the notification
    // endpoint, so a short one is a guessable one.
    expect(() => loadEnvironment({ ...MINIMUM_VALID, WEBHOOK_PATH_SECRET: 'short' })).toThrow(
      EnvironmentValidationError,
    );
  });

  it('refuses a pepper too short to be worth having', () => {
    // A short pepper adds no work for someone brute-forcing a stolen hash table,
    // while giving every operator the impression that it does.
    expect(() => loadEnvironment({ ...MINIMUM_VALID, API_KEY_PEPPER: 'too-short' })).toThrow(
      EnvironmentValidationError,
    );
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
      // A fabricated credential, present precisely so the assertion below can
      // prove it never reaches the error message.
      // scan-secrets:allow
      loadEnvironment({ DATABASE_URL: 'postgres://user:hunter2@host:5432/db', REDIS_URL: '' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).not.toContain('hunter2');
  });
});

describe('an entrypoint asks only for what it uses', () => {
  it('runs migrations without being handed the API key pepper', () => {
    // The migration runner connects as the schema owner, the most privileged role
    // in the system. Requiring the pepper there would put a secret into the
    // environment of the one container that must never need it.
    const environment = loadDatabaseEnvironment({
      DATABASE_URL: 'postgres://user:password@postgres:5432/payment_gateway',
    });

    expect(environment.DATABASE_URL).toContain('postgres://');
    expect(environment.LOG_LEVEL).toBe('info');
    expect(Object.keys(environment)).not.toContain('API_KEY_PEPPER');
  });

  it('still refuses to run migrations without a database', () => {
    expect(() => loadDatabaseEnvironment({})).toThrow(EnvironmentValidationError);
  });

  it('does not let the api start on the database subset alone', () => {
    // The api reads the pepper on every request, so it must fail at startup
    // rather than on the first authentication attempt.
    expect(() =>
      loadEnvironment({
        DATABASE_URL: 'postgres://user:password@postgres:5432/payment_gateway',
        REDIS_URL: 'redis://redis:6379',
      }),
    ).toThrow(EnvironmentValidationError);
  });
});
