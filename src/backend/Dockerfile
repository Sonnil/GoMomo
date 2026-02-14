# ── Dev stage (used by docker-compose for hot-reload) ──────────
FROM node:20-alpine AS dev
WORKDIR /app
COPY src/backend/package.json src/backend/package-lock.json* ./
RUN npm ci
COPY src/backend/tsconfig.json ./
COPY src/backend/src ./src
EXPOSE 3000
CMD ["npx", "tsx", "watch", "src/index.ts"]

# ── Widget builder (compiles the Vite SPA) ─────────────────────
FROM node:20-alpine AS widget-builder
WORKDIR /widget
COPY src/frontend/package.json src/frontend/package-lock.json* ./
RUN npm ci
COPY src/frontend/ ./
# Widget JS uses window.location.origin at runtime when VITE_*
# env vars are absent — no build-time URL needed.
RUN npx tsc && npx vite build

# ── Backend builder (compiles TypeScript for production) ───────
FROM node:20-alpine AS builder
WORKDIR /app
COPY src/backend/package.json src/backend/package-lock.json* ./
RUN npm ci
COPY src/backend/tsconfig.json ./
COPY src/backend/src ./src
RUN npx tsc

# ── Production runtime ────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY src/backend/package.json src/backend/package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/db/migrations ./dist/db/migrations
COPY --from=widget-builder /widget/dist ./widget
EXPOSE 3000
CMD ["node", "dist/index.js"]
