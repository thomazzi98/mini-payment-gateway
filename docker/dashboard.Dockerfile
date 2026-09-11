FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/dashboard/package.json ./apps/dashboard/
# --ignore-scripts for the same reason as the api image: no git hooks, and no
# dependency's postinstall running arbitrary code during the build.
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.base.json ./
COPY apps/dashboard ./apps/dashboard
# Inlined into the bundle; the page still lets a visitor change it.
ARG VITE_GATEWAY_URL=http://127.0.0.1:4010
ENV VITE_GATEWAY_URL=$VITE_GATEWAY_URL
RUN npm run build --workspace apps/dashboard

# Static files behind an unprivileged nginx. No Node at runtime: there is
# nothing to run, and the page talks to the gateway from the browser.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY docker/dashboard.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
