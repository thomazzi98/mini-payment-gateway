// Installs git hooks without husky's own install step, so a fresh clone gets the same
// gates whether or not husky ran. Skipped in CI, where the gates run as explicit jobs.
import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';

if (process.env.CI === 'true') {
  console.log('CI detected, skipping git hook installation.');
  process.exit(0);
}

if (!existsSync('.git')) {
  console.log('Not a git repository, skipping git hook installation.');
  process.exit(0);
}

const hooksDirectory = path.join('.git', 'hooks');
mkdirSync(hooksDirectory, { recursive: true });

const hooks = {
  'pre-commit': '#!/bin/sh\nnpx lint-staged\n',
  'commit-msg': '#!/bin/sh\nnpx --no -- commitlint --edit "$1"\n',
  'pre-push': '#!/bin/sh\nnpm run typecheck && npm run test\n',
};

for (const [name, contents] of Object.entries(hooks)) {
  const path = path.join(hooksDirectory, name);
  writeFileSync(path, contents, { mode: 0o755 });
  chmodSync(path, 0o755);
}

console.log(`Installed git hooks: ${Object.keys(hooks).path.join(', ')}`);
