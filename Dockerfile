FROM node:22-alpine AS deps
WORKDIR /app
ENV NPM_CONFIG_IGNORE_SCRIPTS=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache bash git \
  && addgroup -S specvoice \
  && adduser -S specvoice -G specvoice
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/src ./src
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
RUN chown -R specvoice:specvoice /app
USER specvoice
ENV NPM_CONFIG_IGNORE_SCRIPTS=1
EXPOSE 3000
CMD ["npm", "start"]

FROM runtime AS launcher
USER root
RUN apk add --no-cache docker-cli
CMD ["node", "--import", "tsx", "src/execution-launcher.ts"]

FROM deps AS execution
ARG CLAUDE_CODE_VERSION=2.1.296
RUN apk add --no-cache bash git \
  && npm install --global --ignore-scripts=false "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && claude --version \
  && addgroup -g 10001 -S execution \
  && adduser -u 10001 -S execution -G execution
COPY src ./src
COPY tsconfig.json ./tsconfig.json
ENV DISABLE_AUTOUPDATER=1
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENV NODE_ENV=production
USER 10001:10001
CMD ["sh", "-c", "mkdir -p /work/home /work/tmp /work/npm-cache && exec node --import tsx src/execution/attempt.ts"]

FROM postgres:16-alpine AS backup
RUN apk add --no-cache nodejs restic
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY migrations ./migrations
COPY tsconfig.json package.json ./
ENV RESTIC_CACHE_DIR=/tmp/restic-cache
ENTRYPOINT ["node", "--import", "tsx", "src/scripts/backups.ts"]
CMD ["schedule"]
