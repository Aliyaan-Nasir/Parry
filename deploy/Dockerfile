# The API and every service, one image: pnpm installs the workspace, Bun runs TypeScript directly.
# docker build -f deploy/Dockerfile -t parry-services .
FROM node:22.21.1-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate
# The packages are built below, once their sources are in the image.
ENV PARRY_SKIP_PACKAGE_BUILD=1
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/brand/package.json packages/brand/
COPY packages/sdk/package.json packages/sdk/
COPY packages/mcp/package.json packages/mcp/
COPY services/package.json services/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --prod=false --filter "@parry/api..." --filter "@parry/services..."
# The workspace packages resolve to their built dist, which the build context leaves out.
COPY tsconfig.base.json ./
COPY packages ./packages
RUN pnpm -F @parry/core -F @parry/sdk -F @parry/mcp build

FROM oven/bun:1.3.1-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/services/node_modules ./services/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages ./packages
COPY package.json ./
COPY packages ./packages
COPY services ./services
COPY apps/api ./apps/api
COPY deployments ./deployments
# The local enclave binary is only for sandbox runs; deployed services call OutLayer.
USER bun
# SERVICE=api runs the API; any other name runs that service (see services/src/main.ts).
CMD ["sh", "-c", "if [ \"$SERVICE\" = api ]; then exec bun apps/api/src/index.ts; else exec bun services/src/main.ts \"$SERVICE\"; fi"]
