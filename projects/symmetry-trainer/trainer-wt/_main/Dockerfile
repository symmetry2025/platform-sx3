FROM node:20-bookworm-slim AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# IMPORTANT:
# Build context is expected to be the `projects/` folder (see `infra/prod/docker-compose.yml`).
# We copy both this app and the local `@smmtry/shared` dependency (file:../../../symmetry-account/...).
COPY symmetry-trainer/trainer-wt/_main ./symmetry-trainer/trainer-wt/_main
COPY symmetry-account/account-wt/_main/packages/shared ./symmetry-account/account-wt/_main/packages/shared

WORKDIR /repo/symmetry-trainer/trainer-wt/_main

RUN pnpm -s install --frozen-lockfile
RUN pnpm -s exec prisma generate
RUN pnpm -s exec next build


FROM node:20-bookworm-slim AS runner

ENV NODE_ENV="production"
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /repo/symmetry-trainer/trainer-wt/_main /app
RUN chmod +x /app/scripts/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["bash", "scripts/docker-entrypoint.sh"]

