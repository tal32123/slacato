# Runtime image shared by the NestJS API and the BullMQ worker.
# Both services build from this image and differ only in their start command.
FROM node:22-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app
COPY . .

# --prod=false keeps devDependencies (typescript, drizzle-kit, tsx) even when
# Railway injects NODE_ENV=production into the build environment. The runtime
# needs drizzle-kit and tsx for migrations and fixture ingestion.
RUN pnpm install --frozen-lockfile --prod=false
RUN pnpm exec tsc -b packages/contracts packages/core packages/infrastructure apps/api apps/worker

CMD ["pnpm", "--filter", "@slacato/api", "start"]
