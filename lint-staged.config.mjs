export default {
  '*.{ts,tsx,mts,js,mjs}': ['eslint --fix', 'prettier --write'],
  // Deliberately no `sql`. Prettier has no SQL parser without a plugin, so a new
  // migration could not be committed at all. Adding the plugin would be worse:
  // every applied migration's SHA-256 is recorded in schema_migrations, and
  // reformatting one is indistinguishable from tampering with it.
  '*.{json,md,yml,yaml}': ['prettier --write'],
};
