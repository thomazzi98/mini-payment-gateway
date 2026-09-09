// Validates the Appmax integration against the real sandbox.
//
// This exists because every other Appmax test in this repository uses a local
// server. Those prove our code handles what we believe Appmax sends; only this
// proves what Appmax actually sends.
//
// It refuses to invent a result. With no credentials it exits non-zero with the
// exact variables to set, because a validation script that reports success when
// it validated nothing is worse than no script at all.
//
//   npm run validate:appmax

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXIT_CONFIGURATION = 78; // EX_CONFIG, so CI can tell "not configured" from "broken".
const EXIT_FAILED = 1;

const DIST = path.join('apps', 'api', 'dist');

async function load(relativePath) {
  const absolute = path.resolve(path.join(DIST, relativePath));
  try {
    return await import(pathToFileURL(absolute).href);
  } catch {
    console.error(
      `Could not load ${relativePath} from ${DIST}. Run "npm run build" first: this script drives the compiled adapter, not a copy of it.`,
    );
    process.exit(EXIT_CONFIGURATION);
  }
}

function requiredVariables() {
  return {
    clientId: process.env.APPMAX_CLIENT_ID ?? '',
    clientSecret: process.env.APPMAX_CLIENT_SECRET ?? '',
    documentNumber: process.env.APPMAX_VALIDATION_DOCUMENT_NUMBER ?? '',
  };
}

const steps = [];

function record(name, status, detail) {
  steps.push({ name, status, detail });
  const marker = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' }[status];
  console.log(`  [${marker}] ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

function reportAndExit() {
  const failed = steps.filter((step) => step.status === 'fail');
  const skipped = steps.filter((step) => step.status === 'skip');

  console.log('');
  console.log(
    `${steps.length} step(s): ${steps.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped.`,
  );

  if (failed.length > 0) {
    console.error('\nAppmax sandbox validation FAILED.');
    process.exit(EXIT_FAILED);
  }
  console.log('\nAppmax sandbox validation passed.');
  process.exit(0);
}

console.log('Validating the Appmax integration against the sandbox.\n');

const settings = requiredVariables();

if (settings.clientId === '' || settings.clientSecret === '') {
  console.error('  [FAIL] configuration — Appmax sandbox credentials are not set.');
  console.error('');
  console.error('Set these in the gitignored .env, then run this again:');
  console.error('');
  console.error('  APPMAX_CLIENT_ID=<your sandbox client id>');
  console.error('  APPMAX_CLIENT_SECRET=<your sandbox client secret>');
  console.error('  APPMAX_VALIDATION_DOCUMENT_NUMBER=<a CPF valid in the sandbox>');
  console.error('');
  console.error('They come from an app created in the Appmax AppStore. Creating a');
  console.error('developer account there requires an active CNPJ.');
  console.error('');
  console.error('Nothing was validated. Exiting 78 (configuration).');
  process.exit(EXIT_CONFIGURATION);
}

// Nothing below prints a credential. The client id is not secret but is still
// withheld, because a validation log is exactly the artefact people paste around.
record('configuration', 'pass', 'sandbox credentials present');

const { UndiciAppmaxTransport } = await load(
  path.join('infrastructure', 'providers', 'appmax', 'appmax-http-transport.js'),
);
const { AppmaxTokenCache } = await load(
  path.join('infrastructure', 'providers', 'appmax', 'appmax-token-cache.js'),
);
const { AppmaxPixProvider } = await load(
  path.join('infrastructure', 'providers', 'appmax', 'appmax-provider.js'),
);
const { Secret } = await load(
  path.join('..', '..', '..', 'packages', 'shared', 'dist', 'server', 'index.js'),
);
const { assertPresentableBrCode, inspectBrCode } = await load(
  path.join('domain', 'pix', 'br-code.js'),
);

const quietLogger = {
  debug: () => {},
  warn: () => {},
};

// SANDBOX only. The transport refuses an endpoint override for production, and
// this script never asks for production in the first place.
const transport = new UndiciAppmaxTransport(
  'SANDBOX',
  { clientId: settings.clientId, clientSecret: new Secret(settings.clientSecret) },
  quietLogger,
);

let tokenCache;
try {
  const token = await transport.fetchToken();
  tokenCache = new AppmaxTokenCache(() => Promise.resolve(token));
  record('authentication', 'pass', `token acquired, expires_in=${token.expiresInSeconds}s`);
} catch (error) {
  record('authentication', 'fail', error instanceof Error ? error.message : 'unknown error');
  record('api connectivity', 'skip', 'no token');
  record('pix creation', 'skip', 'no token');
  reportAndExit();
}

// A read of an order that will not exist. A 404 is a perfectly good answer here:
// it proves the host resolved, TLS completed, the token was accepted and the API
// answered. Only an auth failure or a transport failure means anything is wrong.
const provider = new AppmaxPixProvider(transport, tokenCache);
const connectivity = await provider.readPaymentState('1');

function recordConnectivity(result) {
  if (result.outcome === 'success' || result.reason?.includes('no order object')) {
    record('api connectivity', 'pass', 'the API answered an authenticated request');
    return;
  }
  // A 404 is a perfectly good answer: the host resolved, TLS completed and the
  // token was accepted. Only an auth or transport failure means anything is wrong.
  if (result.outcome === 'definitive_failure') {
    record('api connectivity', 'pass', 'the API answered (resource absent, as expected)');
    return;
  }
  record('api connectivity', 'fail', `${result.outcome}: ${result.reason ?? ''}`);
}

recordConnectivity(connectivity);

if (settings.documentNumber === '') {
  record(
    'pix creation',
    'skip',
    'APPMAX_VALIDATION_DOCUMENT_NUMBER is not set, so no order was created',
  );
  record('response parsing', 'skip', 'no Pix created');
  record('br code', 'skip', 'no Pix created');
  record('timestamps', 'skip', 'no Pix created');
  reportAndExit();
}

// One small sandbox charge. Deliberately bounded: this script creates exactly one
// order and never loops, retries or cancels anything.
const amountMinor = 100n;
const created = await provider.createPixInstrument({
  amountMinor,
  currency: 'BRL',
  description: 'Gateway integration validation',
  reference: `validation-${Date.now()}`,
  customer: {
    firstName: 'Integration',
    lastName: 'Validation',
    email: 'integration-validation@example.com',
    phone: '11999999999',
    documentNumber: settings.documentNumber,
    ipAddress: '127.0.0.1',
  },
});

if (created.outcome !== 'success') {
  record('pix creation', 'fail', `${created.outcome}: ${created.reason ?? ''}`);
  record('response parsing', 'skip', 'no Pix created');
  record('br code', 'skip', 'no Pix created');
  record('timestamps', 'skip', 'no Pix created');
  reportAndExit();
}

record('pix creation', 'pass', `order ${created.providerReference}`);

const instrument = created.value;
record(
  'response parsing',
  instrument.copyAndPasteCode.length > 0 ? 'pass' : 'fail',
  `copy-and-paste code length ${instrument.copyAndPasteCode.length}, qr image ${
    instrument.qrCodeImageDataUri === undefined ? 'absent' : 'present'
  }`,
);

const inspection = inspectBrCode(instrument.copyAndPasteCode);
try {
  assertPresentableBrCode(instrument.copyAndPasteCode, amountMinor);
  record(
    'br code',
    'pass',
    `CRC verified, pix domain declared, amount ${inspection.amountMinor ?? 'not declared'}`,
  );
} catch (error) {
  record('br code', 'fail', error instanceof Error ? error.message : 'unknown error');
}

function recordExpiry(expiresAt) {
  if (expiresAt === undefined) {
    record('timestamps', 'skip', 'Appmax returned no expiry');
    return;
  }
  // Read as Brazilian rather than UTC. A wrong offset would land three hours out,
  // which is exactly the mistake worth catching against the real provider.
  const minutesAhead = Math.round((expiresAt.getTime() - Date.now()) / 60_000);
  record(
    'timestamps',
    minutesAhead > 0 ? 'pass' : 'fail',
    `expires in ${minutesAhead} minute(s) (${expiresAt.toISOString()})`,
  );
}

recordExpiry(instrument.expiresAt);

reportAndExit();
