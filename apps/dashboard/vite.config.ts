import { defineConfig } from 'vite';

// One page, no framework. The gateway address is inlined at build time and can
// still be changed on the page, because the same bundle serves a laptop and a
// container that reach the API at different addresses.
export default defineConfig({
  server: { port: 4020, strictPort: true },
  preview: { port: 4020, strictPort: true },
  build: { target: 'es2022', sourcemap: false },
});
