/**
 * Creates a sandbox organization and one API key, and prints the key once.
 *
 * For local development and manual verification against a running stack. The
 * plaintext key is shown exactly once because only its hash is stored, which is
 * the same property the real issuing flow must have.
 *
 * Runs as the schema owner, so it is deliberately not something the api process
 * can do to itself.
 */

import { Pool } from 'pg';
import { generateApiKey, hashApiKeySecret, Secret } from '@gateway/shared/server';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required. Run this through docker compose so it is provided.`);
  }
  return value;
}

const pepper = new Secret(required('API_KEY_PEPPER'));
const requestedEnvironment = process.env.SEED_ENVIRONMENT ?? 'SANDBOX';
if (requestedEnvironment !== 'SANDBOX' && requestedEnvironment !== 'PRODUCTION') {
  throw new Error(`SEED_ENVIRONMENT must be SANDBOX or PRODUCTION, not ${requestedEnvironment}.`);
}
const environment: 'SANDBOX' | 'PRODUCTION' = requestedEnvironment;
const organizationName = process.env.SEED_ORGANIZATION_NAME ?? 'Local Sandbox Merchant';

const pool = new Pool({
  connectionString: required('OWNER_DATABASE_URL'),
  max: 1,
  application_name: 'payment-gateway-seed',
});

const client = await pool.connect();

try {
  await client.query('BEGIN');

  const slug = organizationName.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-');
  const organizationPublicId = `org_${randomIdentifierBody()}`;

  const organization = await client.query<{ id: string; public_id: string }>(
    `INSERT INTO organizations (public_id, name, slug)
     VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, public_id`,
    [organizationPublicId, organizationName, slug],
  );
  const organizationRow = organization.rows[0];
  if (organizationRow === undefined) {
    throw new Error('seeding an organization returned no row');
  }
  const organizationId = organizationRow.id;

  const generated = generateApiKey(environment);
  const keyHash = hashApiKeySecret(generated.identifier, generated.secret, pepper);

  await client.query(
    `INSERT INTO api_keys
       (organization_id, environment, name, key_identifier, key_hash, last_four, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      organizationId,
      environment,
      'local development key',
      generated.identifier,
      keyHash,
      generated.plaintext.expose().slice(-4),
      ['payments:write', 'payments:read'],
    ],
  );

  await client.query('COMMIT');

  process.stdout.write(
    [
      '',
      `Organization: ${organizationRow.public_id} (${organizationName})`,
      `Environment:  ${environment}`,
      '',
      'API key, shown once and never again:',
      '',
      `  ${generated.plaintext.expose()}`,
      '',
      'Only its hash was stored. Losing it means issuing a new one.',
      '',
    ].join('\n'),
  );
} catch (error) {
  await client.query('ROLLBACK');
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  client.release();
  await pool.end();
  process.exit(1);
}

client.release();
await pool.end();

function randomIdentifierBody(): string {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  const bytes = new Uint8Array(26);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet.charAt(byte % alphabet.length)).join('');
}
