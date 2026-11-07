# The site and app as a Node server, for running the whole stack locally (production is on Vercel).
FROM node:22.21.1-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter "@parry/web..."
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_PARRY_NETWORK=testnet
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_PARRY_NETWORK=$NEXT_PUBLIC_PARRY_NETWORK NEXT_TELEMETRY_DISABLED=1
RUN pnpm -F @parry/web build

FROM node:22.21.1-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app /app
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "apps/web", "-p", "3000"]
