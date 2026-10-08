# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/web/Dockerfile .

FROM node:24-alpine AS build
RUN npm install -g pnpm@10.34.6
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @bidrush/web...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @bidrush/web build

FROM nginx:1.29-alpine
# Configured at startup from the environment:
#   PORT           port to listen on (Railway sets it; 80 by default)
#   API_UPSTREAMS  where the API instances are (see nginx/25-bidrush-upstream.sh)
ENV PORT=80 \
    API_UPSTREAMS="api-1:3000 api-2:3000" \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY apps/web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=755 apps/web/nginx/25-bidrush-upstream.sh /docker-entrypoint.d/25-bidrush-upstream.sh
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
