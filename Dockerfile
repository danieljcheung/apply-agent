# Multi-stage Dockerfile for separated web, API, and worker deployments

# --- Base Build Stage ---
FROM node:22-slim AS builder
WORKDIR /app

# Copy dependency files
COPY package*.json ./
RUN npm ci

# Copy web dependency files
COPY web/package*.json ./web/
RUN cd web && npm ci

# Copy application source code
COPY . .

# Build root backend (API and worker) and Next.js web app
RUN npm run build

# --- Web Runtime Stage ---
FROM nginxinc/nginx-unprivileged:alpine AS web
# Copy the custom Nginx configuration
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
# Copy the compiled static Next.js export from the builder
COPY --from=builder /app/web/out /usr/share/nginx/html
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]

# --- API Runtime Stage ---
FROM node:22-slim AS api
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV APPLY_AGENT_DATA_DIR=/app/data

# Run as non-root user
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs -s /bin/sh -m nodejs

# Copy backend dependencies and build artifacts
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist

# Install production dependencies only (no devDependencies or bundled browser runtimes)
RUN npm ci --omit=dev

RUN mkdir -p /app/data && chown -R nodejs:nodejs /app
USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]

# --- Worker Runtime Stage ---
FROM node:22-slim AS worker
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV AUTOMATION_RUNTIME=playwright
ENV APPLY_AGENT_DATA_DIR=/app/data

# Run as non-root user
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs -s /bin/sh -m nodejs

# Copy backend dependencies and build artifacts
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist

# Install production dependencies and Playwright's Chromium runtime with system dependencies
RUN npm ci --omit=dev && \
    node node_modules/playwright/cli.js install --with-deps chromium && \
    chmod -R 755 /ms-playwright && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/data && chown -R nodejs:nodejs /app /ms-playwright
USER nodejs

CMD ["node", "dist/src/worker.js"]
