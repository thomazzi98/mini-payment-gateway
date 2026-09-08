export default {
  '*.{ts,tsx,mts,js,mjs}': ['eslint --fix', 'prettier --write'],
  '*.{json,md,yml,yaml,sql}': ['prettier --write'],
};
