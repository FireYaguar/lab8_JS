# Lab 8: образ у два (точніше, три) етапи. Фінальний — лише Node, prod-залежності, код сервера,
# shared і зібраний клієнт. Без Vite/Vitest/TypeScript/Biome, без npm, не від root.

# ---- 1. збірка клієнта: усі залежності, включно з dev ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci
COPY tsconfig.base.json ./
COPY shared shared
COPY client client
RUN npm run build

# ---- 2. лише production-залежності (pino, ws, zod + посилання на workspaces) ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --omit=dev --ignore-scripts

# ---- 3. фінальний образ ----
FROM node:22-alpine
# npm і yarn у рантаймі не потрібні: процес запускає сам node
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY shared/package.json shared/
COPY shared/src shared/src
COPY server/package.json server/
COPY server/src server/src
COPY --from=build /app/client/dist client/dist
# логи матчів пише користувач node — йому потрібна лише ця тека
RUN mkdir -p server/logs && chown node:node server/logs
ARG GIT_SHA=dev
ARG APP_VERSION=dev
ENV GIT_SHA=$GIT_SHA APP_VERSION=$APP_VERSION
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
# node — PID 1 і сам отримує SIGTERM від docker stop (npm start його б не передав)
CMD ["node", "server/src/index.ts"]
