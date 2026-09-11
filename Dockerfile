# ------------------------------------------------------------------------------------------

FROM node:24-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Copy dependency-related file
COPY package.json .
COPY pnpm-lock.yaml .

RUN corepack enable
RUN corepack install --global pnpm@10.34.1

# ------------------------------------------------------------------------------------------

FROM base AS prod-deps
# Install only production dependencies. This layer changes only when dependency manifests change.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

# ------------------------------------------------------------------------------------------

FROM base AS build-deps
# Keep development dependencies independent from application source changes.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ------------------------------------------------------------------------------------------

FROM build-deps AS builder
COPY . .

# The build number changes every release, so keep it after dependency installation.
ARG HAEJEOK_BUILD_NUMBER
ENV HAEJEOK_BUILD_NUMBER=${HAEJEOK_BUILD_NUMBER}
RUN --mount=type=cache,id=pnpm,target=/pnpm/store VITE_RISU_LEGAL_CONFIGURED=TRUE pnpm build

# ------------------------------------------------------------------------------------------

FROM base AS runtime
WORKDIR /app

COPY package.json .
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/dist ./dist

# Server modules import shared runtime contracts from packages/ at runtime.
RUN node -e "require.resolve('./packages/protocol/modelJobs.cjs'); require.resolve('./packages/chat-core/index.cjs')"

ENV NODE_ENV=production
EXPOSE 6001

CMD ["pnpm", "runserver"]

# ------------------------------------------------------------------------------------------
