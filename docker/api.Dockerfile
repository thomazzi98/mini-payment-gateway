FROM node:24-alpine AS dependencies
WORKDIR /app
# Only manifests are copied first so the install layer is reused whenever
# source changes but dependencies do not.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/provider-simulator/package.json ./apps/provider-simulator/
# --ignore-scripts: the prepare hook installs git hooks for local development and has
# no place in an image. It also stops any dependency's postinstall script from running
# arbitrary code during the build.
RUN npm ci --no-audit --no-fund --ignore-scripts

FROM dependencies AS build
WORKDIR /app
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/provider-simulator/package.json ./apps/provider-simulator/
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/migrations ./apps/api/migrations

# Runs unprivileged. The node image already provides uid/gid 1000.
USER node

EXPOSE 3000
CMD ["node", "apps/api/dist/main.api.js"]
