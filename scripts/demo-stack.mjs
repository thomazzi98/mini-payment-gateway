#!/usr/bin/env node
/**
 * Brings up the whole demonstration: CryptoPay beside a local chain, the WhatsApp
 * Notification Platform with its provider stub, and this gateway joined to both.
 *
 *   node scripts/demo-stack.mjs up       start everything, provision, print the keys
 *   node scripts/demo-stack.mjs status   what is running and whether it answers
 *   node scripts/demo-stack.mjs down     stop all three stacks, keep their data
 *   node scripts/demo-stack.mjs reset    stop all three and discard their data
 *
 * Each stack is started from its own repository with its own compose files; nothing
 * here shares code, images or databases between them. What this script adds is the
 * order, the provisioning each stack exposes through its own surface, and the
 * hand-over of the credentials one stack issues to the stack that must present them.
 * Those land in .env.demo, which is gitignored: they are local development secrets
 * that mean nothing outside this machine.
 *
 * The sibling checkouts default to ../cryptopay and ../whatsapp-notification-platform
 * and can be pointed elsewhere with CRYPTOPAY_DIR and WHATSAPP_DIR.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const gatewayDirectory = path.resolve(import.meta.dirname, '..');
const cryptoPayDirectory = path.resolve(process.env.CRYPTOPAY_DIR ?? '../cryptopay');
const whatsappDirectory = path.resolve(
  process.env.WHATSAPP_DIR ?? '../whatsapp-notification-platform',
);
const demoEnvironmentPath = path.resolve(gatewayDirectory, '.env.demo');

const NETWORK = 'payment-demo';
const CRYPTOPAY_COMPOSE = ['-f', 'docker-compose.yml', '-f', 'docker-compose.local-chain.yml'];
const WHATSAPP_COMPOSE = [
  '-f',
  'docker-compose.yml',
  '-f',
  'docker-compose.demo.yml',
  '--profile',
  'stub',
];
const GATEWAY_COMPOSE = ['-f', 'docker-compose.yml', '-f', 'docker-compose.demo.yml'];

const CRYPTOPAY_URL = 'http://127.0.0.1:3001';
const WHATSAPP_URL = 'http://127.0.0.1:3100';
const WAHA_STUB_URL = 'http://127.0.0.1:3200';
const GATEWAY_URL = 'http://127.0.0.1:4010';
const ANVIL_URL = 'http://127.0.0.1:8545';

const PORTFOLIO_ORIGINS =
  'http://localhost:4321,http://127.0.0.1:4321,https://thomazzi98.github.io';

function log(message) {
  process.stdout.write(`${message}\n`);
}

class DemoFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'DemoFailure';
  }
}

// Thrown rather than exiting on the spot: a process that exits while a fetch is
// still winding down trips a libuv assertion on Windows, and the message is lost.
function fail(message) {
  throw new DemoFailure(message);
}

function run(directory, arguments_, options = {}) {
  const result = spawnSync('docker', arguments_, {
    cwd: directory,
    encoding: 'utf8',
    stdio: options.capture === true ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, ...options.env },
    shell: false,
  });
  if (result.status !== 0 && options.allowFailure !== true) {
    fail(
      `docker ${arguments_.join(' ')} failed in ${directory}${result.stderr ? `\n${result.stderr}` : ''}`,
    );
  }
  return result;
}

function compose(directory, composeArguments, rest, options = {}) {
  return run(directory, ['compose', ...composeArguments, ...rest], options);
}

function readEnvironmentFile(path) {
  if (!existsSync(path)) {
    return {};
  }
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match !== null) {
      values[match[1]] = match[2];
    }
  }
  return values;
}

function writeDemoEnvironment(values) {
  const lines = [
    '# Written by scripts/demo-stack.mjs. Local development credentials for the demo',
    '# topology; gitignored, and worthless outside this machine.',
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    '',
  ];
  writeFileSync(demoEnvironmentPath, lines.join('\n'), 'utf8');
}

async function waitFor(description, isSatisfied, timeoutMilliseconds = 120_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      if (await isSatisfied()) {
        return;
      }
    } catch {
      // Not up yet.
    }
    await new Promise((settle) => setTimeout(settle, 2000));
  }
  fail(`Timed out waiting for ${description}.`);
}

async function isHealthy(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  return response.ok;
}

function ensureNetwork() {
  const existing = run(gatewayDirectory, ['network', 'inspect', NETWORK], {
    capture: true,
    allowFailure: true,
  });
  if (existing.status === 0) {
    return;
  }
  run(gatewayDirectory, ['network', 'create', NETWORK]);
  log(`created the ${NETWORK} network`);
}

// --- CryptoPay -----------------------------------------------------------------

function cryptoPayApiKeyFromLogs() {
  const logs = compose(
    cryptoPayDirectory,
    CRYPTOPAY_COMPOSE,
    ['logs', '--no-log-prefix', 'bootstrap'],
    {
      capture: true,
    },
  );
  const match = /(cp_test_[A-Za-z0-9_-]+)/.exec(logs.stdout ?? '');
  return match?.[1];
}

function issueCryptoPayApiKey() {
  const issued = compose(
    cryptoPayDirectory,
    CRYPTOPAY_COMPOSE,
    [
      'run',
      '--rm',
      '--no-deps',
      'bootstrap',
      'node',
      'apps/api/dist/infrastructure/persistence/bootstrap-cli.js',
      'test',
      '--issue-key',
    ],
    { capture: true },
  );
  const match = /(cp_test_[A-Za-z0-9_-]+)/.exec(issued.stdout ?? '');
  if (match === undefined || match === null) {
    fail('CryptoPay did not print an API key. Inspect `docker compose logs bootstrap` there.');
  }
  return match[1];
}

function cryptoPayWebhookSecrets() {
  const read = compose(
    cryptoPayDirectory,
    CRYPTOPAY_COMPOSE,
    ['run', '--rm', '--no-deps', 'bootstrap', 'cat', '/demo-secret/webhook-signing-secrets'],
    { capture: true },
  );
  const secrets = (read.stdout ?? '').trim();
  if (!secrets.startsWith('whsec_')) {
    fail('CryptoPay has not written its webhook signing secret yet.');
  }
  return secrets;
}

async function startCryptoPay(demo) {
  log('\n== CryptoPay, with a local chain ==');
  compose(cryptoPayDirectory, CRYPTOPAY_COMPOSE, ['up', '-d', '--build']);
  await waitFor('the CryptoPay API', () => isHealthy(`${CRYPTOPAY_URL}/healthz`));
  await waitFor('the local chain', async () => {
    const response = await fetch(ANVIL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    return response.ok;
  });

  const apiKey = demo.CRYPTOPAY_API_KEY || cryptoPayApiKeyFromLogs() || issueCryptoPayApiKey();
  const secrets = cryptoPayWebhookSecrets();

  const networks = await fetch(`${CRYPTOPAY_URL}/v1/networks`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!networks.ok) {
    fail(
      `The CryptoPay key was refused (${networks.status}). Delete CRYPTOPAY_API_KEY from .env.demo and run again.`,
    );
  }
  const listed = await networks.json();
  const local = listed.data?.find((network) => network.network === 'local-anvil');
  if (local === undefined || local.assets.length === 0) {
    fail(
      'CryptoPay is not watching the local chain with a USDC asset. Inspect its bootstrap logs.',
    );
  }
  log(`CryptoPay watches local-anvil with USDC at ${local.assets[0].reference}`);
  return { apiKey, secrets };
}

// --- WhatsApp Notification Platform ---------------------------------------------

/**
 * A dashboard call, as the browser makes it: the session cookie, and on anything
 * that changes state the CSRF token the session response handed out.
 */
async function whatsappRequest(path, options = {}) {
  const response = await fetch(`${WHATSAPP_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.session !== undefined && {
        cookie: options.session.cookie,
        'x-csrf-token': options.session.csrfToken,
      }),
      ...(options.bearer !== undefined && { authorization: `Bearer ${options.bearer}` }),
    },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, cookie: response.headers.get('set-cookie') ?? undefined };
}

function sessionCookieOf(setCookie) {
  return setCookie?.split(';', 1)[0];
}

async function signIn(demo) {
  if (demo.DEMO_WHATSAPP_EMAIL && demo.DEMO_WHATSAPP_PASSWORD) {
    const login = await whatsappRequest('/dashboard/auth/login', {
      method: 'POST',
      body: { email: demo.DEMO_WHATSAPP_EMAIL, password: demo.DEMO_WHATSAPP_PASSWORD },
    });
    if (login.status === 200) {
      return {
        session: { cookie: sessionCookieOf(login.cookie), csrfToken: login.body.csrfToken },
        email: demo.DEMO_WHATSAPP_EMAIL,
        password: demo.DEMO_WHATSAPP_PASSWORD,
      };
    }
  }
  const email = `demo-${randomBytes(4).toString('hex')}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const registered = await whatsappRequest('/dashboard/auth/register', {
    method: 'POST',
    body: { organizationName: 'Payment Gateway Demo', name: 'Demo Operator', email, password },
  });
  if (registered.status !== 201 && registered.status !== 200) {
    fail(
      `Could not register a dashboard account on the notification platform (${registered.status}): ${JSON.stringify(registered.body)}`,
    );
  }
  return {
    session: { cookie: sessionCookieOf(registered.cookie), csrfToken: registered.body.csrfToken },
    email,
    password,
  };
}

async function ensureApplication(session, demo) {
  if (demo.DEMO_WHATSAPP_APPLICATION_ID) {
    const existing = await whatsappRequest(
      `/dashboard/applications/${demo.DEMO_WHATSAPP_APPLICATION_ID}`,
      { session },
    );
    if (existing.status === 200) {
      return demo.DEMO_WHATSAPP_APPLICATION_ID;
    }
  }
  const created = await whatsappRequest('/dashboard/applications', {
    method: 'POST',
    session,
    body: { name: 'Payment Gateway', slug: 'payment-gateway' },
  });
  if (created.status !== 201) {
    fail(
      `Could not create the notification application (${created.status}): ${JSON.stringify(created.body)}`,
    );
  }
  return created.body.id;
}

async function ensureApiKey(session, applicationId, demo) {
  if (demo.WHATSAPP_NOTIFICATION_API_KEY) {
    const probe = await whatsappRequest('/v1/notifications?limit=1', {
      bearer: demo.WHATSAPP_NOTIFICATION_API_KEY,
    });
    if (probe.status === 200) {
      return demo.WHATSAPP_NOTIFICATION_API_KEY;
    }
  }
  const created = await whatsappRequest(`/dashboard/applications/${applicationId}/api-keys`, {
    method: 'POST',
    session,
    body: { name: 'payment-gateway', scopes: ['notifications:write', 'notifications:read'] },
  });
  if (created.status !== 201) {
    fail(
      `Could not create a notification API key (${created.status}): ${JSON.stringify(created.body)}`,
    );
  }
  return created.body.plaintextKey;
}

async function ensureConnectedSession(session, applicationId, demo) {
  const base = `/dashboard/applications/${applicationId}/whatsapp-sessions`;
  let sessionId = demo.DEMO_WHATSAPP_SESSION_ID;
  let connection = sessionId
    ? await whatsappRequest(`${base}/${sessionId}`, { session })
    : undefined;
  if (connection === undefined || connection.status !== 200) {
    const created = await whatsappRequest(base, {
      method: 'POST',
      session,
      body: { displayName: 'Payment confirmations' },
    });
    if (created.status !== 201) {
      fail(
        `Could not create a WhatsApp connection (${created.status}): ${JSON.stringify(created.body)}`,
      );
    }
    sessionId = created.body.id;
    connection = created;
  }
  if (connection.body.status !== 'WORKING') {
    await whatsappRequest(`${base}/${sessionId}/start`, { method: 'POST', session });
    await whatsappRequest(`${base}/${sessionId}/qr-code`, { session });
    // The stub stands in for a person scanning the code with a phone.
    const scan = await fetch(`${WAHA_STUB_URL}/__stub/sessions/wnp-${sessionId}/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '5511999990000' }),
    });
    if (!scan.ok) {
      fail(`The provider stub refused the scan (${scan.status}). Is the stub profile running?`);
    }
    await waitFor(
      'the WhatsApp connection to pair',
      async () => {
        const current = await whatsappRequest(`${base}/${sessionId}`, { session });
        return current.body?.status === 'WORKING';
      },
      60_000,
    );
  }
  return sessionId;
}

async function startWhatsapp(demo) {
  log('\n== WhatsApp Notification Platform, with the provider stub ==');
  compose(whatsappDirectory, WHATSAPP_COMPOSE, ['up', '-d', '--build']);
  await waitFor('the notification API', () => isHealthy(`${WHATSAPP_URL}/health`));
  await waitFor('the provider stub', () => isHealthy(`${WAHA_STUB_URL}/ping`));

  const account = await signIn(demo);
  const applicationId = await ensureApplication(account.session, demo);
  const apiKey = await ensureApiKey(account.session, applicationId, demo);
  const sessionId = await ensureConnectedSession(account.session, applicationId, demo);
  log(`notification application ${applicationId} is paired through the stub`);
  return { account, applicationId, apiKey, sessionId };
}

// --- The gateway ----------------------------------------------------------------

function seedGatewayApiKey() {
  const environment = readEnvironmentFile(path.resolve(gatewayDirectory, '.env'));
  const ownerUrl = `postgres://${environment.POSTGRES_USER ?? 'payment_gateway_owner'}:${environment.POSTGRES_PASSWORD}@postgres:5432/${environment.POSTGRES_DB ?? 'payment_gateway'}`;
  const seeded = compose(
    gatewayDirectory,
    [...GATEWAY_COMPOSE, '--env-file', '.env', '--env-file', '.env.demo'],
    [
      'run',
      '--rm',
      '--no-deps',
      '-e',
      `OWNER_DATABASE_URL=${ownerUrl}`,
      '-e',
      'SEED_ORGANIZATION_NAME=Portfolio Demo Merchant',
      // 100 USDC, in six-decimal minor units. The default suits BRL cents.
      '-e',
      'SEED_MAXIMUM_PAYMENT_AMOUNT_MINOR=100000000',
      'api',
      'node',
      'apps/api/dist/infrastructure/persistence/seed-api-key-cli.js',
    ],
    { capture: true },
  );
  const match = /(mpg_test_[A-Za-z0-9]+)/.exec(seeded.stdout ?? '');
  if (match === null) {
    fail(`The gateway did not print an API key:\n${seeded.stdout}\n${seeded.stderr}`);
  }
  return match[1];
}

async function startGateway(demo, cryptoPay, whatsapp) {
  log('\n== Payment gateway ==');
  const values = {
    ...demo,
    CRYPTOPAY_BASE_URL: 'http://cryptopay:3001',
    CRYPTOPAY_API_KEY: cryptoPay.apiKey,
    CRYPTOPAY_ENVIRONMENT: 'SANDBOX',
    CRYPTOPAY_NETWORK: 'polygon',
    CRYPTOPAY_CURRENCIES: 'USDC',
    CRYPTOPAY_CALLBACK_URL: 'http://payment-gateway:3000/v1/webhooks/cryptopay',
    CRYPTOPAY_WEBHOOK_SECRETS: cryptoPay.secrets,
    WHATSAPP_NOTIFICATION_BASE_URL: 'http://whatsapp-notification:3000',
    WHATSAPP_NOTIFICATION_API_KEY: whatsapp.apiKey,
    HTTP_CORS_ALLOWED_ORIGINS: PORTFOLIO_ORIGINS,
    DEMO_WHATSAPP_EMAIL: whatsapp.account.email,
    DEMO_WHATSAPP_PASSWORD: whatsapp.account.password,
    DEMO_WHATSAPP_APPLICATION_ID: whatsapp.applicationId,
    DEMO_WHATSAPP_SESSION_ID: whatsapp.sessionId,
  };
  writeDemoEnvironment(values);

  compose(
    gatewayDirectory,
    [...GATEWAY_COMPOSE, '--env-file', '.env', '--env-file', '.env.demo'],
    ['up', '-d', '--build'],
  );
  await waitFor('the gateway API', () => isHealthy(`${GATEWAY_URL}/health`));

  let gatewayKey = values.DEMO_GATEWAY_API_KEY;
  if (gatewayKey) {
    const probe = await fetch(`${GATEWAY_URL}/v1/payments/pay_0123456789abcdefghjkmnpqrs`, {
      headers: { authorization: `Bearer ${gatewayKey}` },
    });
    if (probe.status === 401) {
      gatewayKey = undefined;
    }
  }
  if (!gatewayKey) {
    gatewayKey = seedGatewayApiKey();
    writeDemoEnvironment({ ...values, DEMO_GATEWAY_API_KEY: gatewayKey });
  }
  return gatewayKey;
}

// --- Commands -------------------------------------------------------------------

async function up() {
  for (const [name, directory] of [
    ['CryptoPay', cryptoPayDirectory],
    ['the notification platform', whatsappDirectory],
  ]) {
    if (!existsSync(path.resolve(directory, 'docker-compose.yml'))) {
      fail(
        `The checkout of ${name} was not found at ${directory}. Set CRYPTOPAY_DIR or WHATSAPP_DIR.`,
      );
    }
  }
  ensureNetwork();
  const demo = readEnvironmentFile(demoEnvironmentPath);
  const cryptoPay = await startCryptoPay(demo);
  const whatsapp = await startWhatsapp(demo);
  const gatewayKey = await startGateway(demo, cryptoPay, whatsapp);

  log('\n== Ready ==');
  log(`gateway            ${GATEWAY_URL}`);
  log(`cryptopay          ${CRYPTOPAY_URL}   (dashboard http://localhost:3000)`);
  log(`notification api   ${WHATSAPP_URL}   (dashboard http://127.0.0.1:8080)`);
  log(
    `local chain        ${ANVIL_URL}  (chain id 31337, USDC 0x5fbdb2315678afecb367f032d93f642f64180aa3)`,
  );
  log('');
  log('Gateway API key for the portfolio demo page and the end-to-end test:');
  log(`  ${gatewayKey}`);
  log('');
  log('Run the end-to-end flow with:');
  log(`  GATEWAY_API_KEY=${gatewayKey} WHATSAPP_API_KEY=${whatsapp.apiKey} npm run test:e2e`);
}

async function status() {
  for (const [name, directory, composeArguments] of [
    ['cryptopay', cryptoPayDirectory, CRYPTOPAY_COMPOSE],
    ['whatsapp-notification-platform', whatsappDirectory, WHATSAPP_COMPOSE],
    ['mini-payment-gateway', gatewayDirectory, GATEWAY_COMPOSE],
  ]) {
    log(`\n== ${name} ==`);
    compose(directory, composeArguments, ['ps', '--format', '{{.Name}}\t{{.Status}}'], {
      allowFailure: true,
    });
  }
  log('');
  for (const [name, url] of [
    ['gateway', `${GATEWAY_URL}/health`],
    ['cryptopay', `${CRYPTOPAY_URL}/healthz`],
    ['notification platform', `${WHATSAPP_URL}/health`],
    ['provider stub', `${WAHA_STUB_URL}/ping`],
  ]) {
    let answer = 'down';
    try {
      answer = (await isHealthy(url)) ? 'up' : 'unhealthy';
    } catch {
      // down
    }
    log(`${name.padEnd(22)} ${answer}`);
  }
}

function down(discardData) {
  const rest = discardData ? ['down', '-v', '--remove-orphans'] : ['down', '--remove-orphans'];
  compose(gatewayDirectory, GATEWAY_COMPOSE, rest, { allowFailure: true });
  compose(whatsappDirectory, WHATSAPP_COMPOSE, rest, { allowFailure: true });
  compose(cryptoPayDirectory, CRYPTOPAY_COMPOSE, rest, { allowFailure: true });
  if (discardData && existsSync(demoEnvironmentPath)) {
    writeFileSync(demoEnvironmentPath, '', 'utf8');
  }
}

const COMMANDS = {
  up,
  status,
  down: () => down(false),
  reset: () => down(true),
};

const command = COMMANDS[process.argv[2] ?? 'up'];
try {
  if (command === undefined) {
    fail('Usage: node scripts/demo-stack.mjs <up|status|down|reset>');
  }
  await command();
} catch (error) {
  if (!(error instanceof DemoFailure)) {
    throw error;
  }
  process.stderr.write(`\n${error.message}\n`);
  process.exitCode = 1;
}
