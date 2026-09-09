// Fails the build when a credential-shaped literal is committed.
//
// A leaked secret is the one mistake a revert does not undo: once it is in the
// history it must be rotated, not deleted. So this runs before the other gates in
// CI, and it scans tracked files rather than the working tree, because what
// matters is what git will carry.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const PATTERNS = [
  {
    name: 'gateway API key',
    // Our own format. Caught by our own scanner rather than only by a provider's.
    pattern: /\bmpg_(live|test)_[0-9A-Za-z]{44}\b/g,
  },
  { name: 'private key block', pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  { name: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/g },
  { name: 'Slack token', pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g },
  { name: 'Stripe secret key', pattern: /\b[sr]k_(live|test)_[0-9A-Za-z]{20,}\b/g },
  { name: 'Anthropic API key', pattern: /\bsk-ant-[0-9A-Za-z_-]{20,}\b/g },
  { name: 'OpenAI API key', pattern: /\bsk-[A-Za-z0-9]{32,}\b/g },
  {
    name: 'JSON web token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    name: 'connection string with an inline password',
    // Any scheme, but only when a password is actually present and is not an
    // obvious placeholder.
    pattern:
      /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:(?!change_me|password|placeholder|\*+)[^\s:/@]{6,}@/g,
  },
];

// A committed example file must show the SHAPE of a credential without carrying a
// real one. These are the only places a placeholder is expected to live.
const ALLOWED_PATHS = new Set(['.env.example', 'scripts/scan-secrets.mjs']);

// A deliberate fixture — a fake credential a test needs in order to prove it is
// handled safely — is marked in the source and skipped here. The marker is
// per-line and must be written out, so silencing a finding is a visible decision
// in a diff rather than a pattern quietly loosened for everyone.
const ALLOW_MARKER = 'scan-secrets:allow';

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.zip',
  '.gz',
  '.mp4',
  '.webm',
]);

const MAXIMUM_FILE_BYTES = 2_000_000;
const NEWLINE = String.fromCodePoint(10);
const NULL_BYTE = String.fromCodePoint(0);

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split(NULL_BYTE)
    .filter((path) => path.length > 0);
}

function isScannable(path) {
  if (ALLOWED_PATHS.has(path)) {
    return false;
  }
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (BINARY_EXTENSIONS.has(extension)) {
    return false;
  }
  if (path === 'package-lock.json') {
    return false;
  }
  try {
    return statSync(path).size <= MAXIMUM_FILE_BYTES;
  } catch {
    return false;
  }
}

function readTextOrNothing(path) {
  try {
    const contents = readFileSync(path, 'utf8');
    return contents.includes(NULL_BYTE) ? undefined : contents;
  } catch {
    return;
  }
}

function findingsInFile(path, contents) {
  const found = [];
  const lines = contents.split(NEWLINE);

  for (const [index, line] of lines.entries()) {
    const previousLine = index > 0 ? (lines[index - 1] ?? '') : '';
    if (line.includes(ALLOW_MARKER) || previousLine.includes(ALLOW_MARKER)) {
      continue;
    }
    for (const { name, pattern } of PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        found.push({ path, line: index + 1, name });
      }
    }
  }

  return found;
}

const findings = trackedFiles()
  .filter((candidate) => isScannable(candidate))
  .flatMap((path) => {
    const contents = readTextOrNothing(path);
    return contents === undefined ? [] : findingsInFile(path, contents);
  });

if (findings.length > 0) {
  console.error(`Found ${findings.length} possible secret(s) in tracked files:`);
  for (const finding of findings) {
    // The match itself is never printed: doing so would copy the secret into CI
    // logs, which are usually more widely readable than the repository.
    console.error(`  ${finding.path}:${finding.line}  ${finding.name}`);
  }
  console.error('Rotate the credential, then remove it from the file and the history.');
  process.exit(1);
}

console.log('No credential-shaped literals found in tracked files.');
