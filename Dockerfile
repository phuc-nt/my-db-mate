# My DB Mate — app container. Multi-stage: install deps, bake the embedding model
# into the image (RT-F3/F8 — no HF CDN fetch at runtime), build, run.
FROM node:24-slim AS deps
WORKDIR /app
# better-sqlite3 needs build tools for its native addon.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# Pre-download the multilingual embedding model into a known cache dir so the
# runtime never hits the Hugging Face CDN ("docker compose up" on a clean box).
#
# Retried, because this is the one build step that depends on a third-party CDN.
# The multi-arch build fetches the same model twice at once from one runner IP,
# and Hugging Face answered the amd64 leg with HTTP 429 while arm64 succeeded --
# that alone failed the whole v0.15.1 publish. Backoff spreads the two legs apart
# and rides out a transient rate limit instead of losing the release to it.
FROM deps AS model
ENV TRANSFORMERS_CACHE=/model-cache
COPY docker/cache-model.mjs ./cache-model.mjs
RUN node cache-model.mjs

FROM deps AS build
COPY . .
ARG DATABASE_URL=postgres://build:build@localhost:5432/build
ENV DATABASE_URL=${DATABASE_URL}
RUN npm run build

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV TRANSFORMERS_OFFLINE=1
ENV TRANSFORMERS_CACHE=/model-cache
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
# drizzle-kit reads the schema files at migrate time, and drizzle.config.ts
# points at src/core/db — copy that path, not the pre-restructure src/db.
COPY --from=build /app/src/core/db ./src/core/db
# Baked model cache so the runtime never fetches from the HF CDN (RT-F3/F8).
COPY --from=model /model-cache /model-cache
EXPOSE 3000
# Run migrations then start (app-db must be reachable via DATABASE_URL).
CMD ["sh", "-c", "npx drizzle-kit migrate && npm run start"]
