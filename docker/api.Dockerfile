FROM node:24-alpine AS dependencies
WORKDIR /app
# Only manifests are copied first so the install layer is reused whenever
# source changes but dependencies do not.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
# --ignore-scripts: the prepare hook installs git hooks for local development and has
# no place in an image. It also stops any dependency's postinstall script from running
# arbitrary code during the build.
RUN npm ci --no-audit --no-fund --ignore-scripts

FROM dependencies AS build
WORKDIR /app
COPY tsconfig.base.json tsconfig.json vitest.config.ts ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN npm run build

# Integration tests run inside the compose network, because the datastores sit on
# an internal network with no published port. This stage keeps devDependencies and
# the sources, which the runtime image deliberately does not.
FROM build AS test
WORKDIR /app
CMD ["npx", "vitest", "run", "--project", "integration"]

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/migrations ./apps/api/migrations
# Operational entrypoints run against the deployed image, not a checkout. Without
# these, the documented "docker compose run --rm api npm run validate:appmax"
# fails with a module-not-found rather than validating anything.
COPY scripts ./scripts

# Runs unprivileged. The node image already provides uid/gid 1000.
USER node

EXPOSE 3000
CMD ["node", "apps/api/dist/main.api.js"]
