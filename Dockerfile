# ------------------------------------------------------------------------------------------

FROM node:24-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Copy dependency-related file
COPY package.json .
COPY pnpm-lock.yaml .
COPY pnpm-workspace.yaml .
COPY server/node/package.json server/node/package.json

RUN corepack enable
RUN corepack install --global pnpm@12.3.4

# ------------------------------------------------------------------------------------------

FROM base AS build-deps
# Keep development dependencies independent from application source changes.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ------------------------------------------------------------------------------------------

FROM build-deps AS prod-deps
# Produce a portable dependency tree containing only the Node server's runtime packages.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @risuai/node-server deploy --legacy --prod /runtime

# ------------------------------------------------------------------------------------------

FROM build-deps AS builder
COPY . .

# The build number changes every release, so keep it after dependency installation.
ARG HAEJEOK_BUILD_NUMBER
ARG VITE_RISU_LEGAL_CONFIGURED
ENV HAEJEOK_BUILD_NUMBER=${HAEJEOK_BUILD_NUMBER}
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    VITE_RISU_LEGAL_CONFIGURED="${VITE_RISU_LEGAL_CONFIGURED}" pnpm build

# ------------------------------------------------------------------------------------------

FROM node:24-slim AS runtime
WORKDIR /app

COPY --from=prod-deps /runtime/node_modules /app/node_modules
COPY --from=builder /app/server/node ./server/node
COPY --from=builder /app/packages/backup-core/src ./packages/backup-core/src
COPY --from=builder /app/packages/backup-core/package.json ./packages/backup-core/package.json
COPY --from=builder /app/packages/protocol/src ./packages/protocol/src
COPY --from=builder /app/packages/protocol/*.ts /app/packages/protocol/package.json /app/packages/protocol/settings.json ./packages/protocol/
COPY --from=builder /app/packages/chat-core ./packages/chat-core
COPY --from=builder /app/dist ./dist

# Fail the image build if any native or vendor-specific runtime package is absent.
RUN node -e "for (const id of Object.keys(require('./server/node/package.json').dependencies)) require.resolve(id)"

ENV NODE_ENV=production
EXPOSE 6001

CMD ["node", "server/node/server.ts"]

# ------------------------------------------------------------------------------------------
