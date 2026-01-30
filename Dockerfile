# syntax=docker/dockerfile:1.4

##############################################
## 🔨 Build Stage — Build Directus with pnpm
FROM node:22-alpine AS builder

WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=8192

# Add core tools, handle arm64 builds
ARG TARGETPLATFORM
RUN apk --no-cache add curl \
  && if [ "$TARGETPLATFORM" = "linux/arm64" ]; then \
       apk add --no-cache python3 build-base \
       && ln -sf /usr/bin/python3 /usr/bin/python; \
     fi

# Enable pnpm and fetch deps
COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
  && corepack prepare pnpm@8.15.4 --activate \
  && npm install -g pnpm --force \
  && pnpm fetch

# Copy source and build
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm run build \
  && pnpm --filter directus deploy --prod dist

# Build custom extensions (use npm to isolate from workspace)
RUN cd extensions/hooks/search-sync \
  && npm install --legacy-peer-deps \
  && npx directus-extension build

# Clean and finalize dist
RUN cd dist \
  && node -e 'const fs=require("fs");const f="package.json",{name,version,type,exports,bin}=require(`./${f}`),{packageManager}=require(`../${f}`);fs.writeFileSync(f,JSON.stringify({name,version,type,exports,bin,packageManager},null,2));' \
  && mkdir -p extensions

# Copy built extension to dist/extensions (Directus expects the full package)
RUN cp -r extensions/hooks/search-sync dist/extensions/directus-extension-search-sync

##############################################
## 🚀 Runtime Stage — Run Agency OS
FROM node:22-alpine AS runtime

# Install PM2
RUN apk --no-cache add curl && npm install -g pm2@5

# Non-root user for security
USER node
WORKDIR /app

# Runtime environment config
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    WEBSOCKETS_ENABLED=true

# Copy artifacts from builder
COPY --from=builder --chown=node:node /app/ecosystem.config.cjs .
COPY --from=builder --chown=node:node /app/dist .

EXPOSE 8056

# Start Agency OS Directus via PM2
CMD ["pm2-runtime", "start", "ecosystem.config.cjs"]
