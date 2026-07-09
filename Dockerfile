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
FROM deps AS model
ENV TRANSFORMERS_CACHE=/model-cache
RUN node -e "import('@huggingface/transformers').then(m=>{m.env.cacheDir='/model-cache';return m.pipeline('feature-extraction','Xenova/paraphrase-multilingual-MiniLM-L12-v2')}).then(()=>console.log('model cached')).catch(e=>{console.error(e);process.exit(1)})"

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
COPY --from=build /app/src/db ./src/db
# Baked model cache so the runtime never fetches from the HF CDN (RT-F3/F8).
COPY --from=model /model-cache /model-cache
EXPOSE 3000
# Run migrations then start (app-db must be reachable via DATABASE_URL).
CMD ["sh", "-c", "npx drizzle-kit migrate && npm run start"]
