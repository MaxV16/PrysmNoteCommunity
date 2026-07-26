FROM node:20-alpine AS builder

WORKDIR /app

COPY apps/frontend/package.json .
RUN npm install

COPY apps/frontend/ .
COPY ee/apps/frontend/ee ./ee
RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json .

EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
