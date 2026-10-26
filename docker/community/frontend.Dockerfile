# Community Edition frontend image (Next.js).
#
# Build context MUST be a tree that has already been through
# `scripts/strip-community.sh`: there is no `ee/` directory to copy, and every
# enterprise import has already been stripped out of the source.
FROM node:20-alpine AS builder

WORKDIR /app

COPY apps/frontend/package.json ./
RUN npm install --no-audit --no-fund

COPY apps/frontend/ ./

# NEXT_PUBLIC_* values are compiled into the client bundle, so the API origin is
# a build argument, not a runtime variable. Default matches the compose stack:
# browser on localhost:3000 talking to the API on localhost:8000.
ARG NEXT_PUBLIC_API_URL=http://localhost:8000/api
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/next.config.ts ./next.config.ts

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node_modules/.bin/next", "start", "-p", "3000"]
