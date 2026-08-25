# syntax=docker/dockerfile:1

# --- build: compile TypeScript with devDependencies available ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime: production dependencies and compiled output only ---
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# src/migrate.ts resolves db/schema.sql relative to the compiled output, so the
# schema ships with the image and a fresh database migrates itself on startup.
COPY db ./db

USER node
EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=6 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/server.js"]
