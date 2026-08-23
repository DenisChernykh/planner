# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
# check=error=true

ARG NODE_IMAGE=node:24.18.0-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573

FROM ${NODE_IMAGE} AS dependencies
ENV HUSKY=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    corepack enable && \
    corepack install --global pnpm@11.15.1 && \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

FROM dependencies AS source
COPY --chown=node:node prisma.config.ts nest-cli.json tsconfig.base.json tsconfig.json tsconfig.build.json ./
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node src ./src

FROM source AS development
ENV NODE_ENV=development \
    API_HOST=0.0.0.0 \
    pnpm_config_verify_deps_before_run=false
RUN mkdir -p /app/dist && chown -R node:node /app/dist
USER node
EXPOSE 3000
CMD ["pnpm", "build:compiled"]

FROM source AS build
RUN pnpm run build:compiled && \
    CI=true pnpm prune --prod

FROM ${NODE_IMAGE} AS runtime
RUN corepack enable && \
    corepack install --global pnpm@11.15.1 && \
    rm -rf /usr/local/lib/node_modules/npm && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    pnpm_config_verify_deps_before_run=false
WORKDIR /app
COPY --chown=node:node --from=build /app/package.json ./package.json
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/prisma ./prisma
COPY --chown=node:node --from=build /app/prisma.config.ts ./prisma.config.ts
USER node
EXPOSE 3000
CMD ["node", "dist/bootstrap/api/main.js"]
