# BUILD-PLAN step 40 (FOUND-9) — NFR-2.11, SRS §2.1.
#
# Multi-stage: `builder` has the toolchain needed to install and generate
# the Prisma client (node-gyp for bcrypt's native addon, Prisma's own
# generate step); `runtime` is what actually ships — production
# dependencies only, no compiler, no Prisma CLI, no test files. It does
# still carry the schema/migrations/lockfile (see the comment where
# they're copied, near the bottom) so `prisma migrate deploy` CAN be run
# against this exact image as an explicit, separate command — §5.5
# forbids migrations running automatically inside the container, which is
# a different thing: nothing in this file's own ENTRYPOINT ever touches
# them. See server/src/index.js's comment on why `prisma migrate deploy`
# must never appear in this file or in `npm start`.
#
# Node 20 LTS, matching server/.nvmrc exactly — .nvmrc pins the MAJOR
# ("20"), not a patch, so `node:20-alpine` (which floats within 20.x) is
# the literal match, not an approximation of it.

FROM node:20-alpine AS builder
WORKDIR /app

# python3/make/g++: node-gyp's toolchain, needed only to compile bcrypt's
# native addon for this image's musl/alpine target — Prisma's own engine
# binary is downloaded prebuilt, this is for bcrypt specifically.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
# Frozen lockfile (BUILD-PLAN's own words) — `npm ci`, never `npm install`,
# which would happily resolve drift instead of failing on it.
RUN npm ci

# The schema (and prisma.config.js, which the Prisma 7 CLI reads for the
# datasource url even at generate time) copied in before the rest of the
# source, so an unrelated source change doesn't invalidate this layer.
COPY prisma.config.js ./
COPY prisma/schema.prisma ./prisma/schema.prisma
# `prisma generate` reads schema and config but never connects to the
# database — this value only has to satisfy prisma.config.js's env()
# lookup, not point at anything real.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npx prisma generate

COPY src ./src

# Strips devDependencies (including the Prisma CLI and node-gyp's own
# packages) from node_modules IN PLACE, after generate has already
# written the client into node_modules/.prisma — prune only removes
# packages npm's own dependency graph says are dev-only, and that
# generated output isn't one, so it survives.
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app

# openssl: Prisma's query engine binary links against it at runtime on
# Alpine; without this the first query fails, not the boot.
RUN apk add --no-cache openssl

# GIT_SHA / BUILD_TIMESTAMP (server/.env.example, FR-4.8): baked into the
# image at BUILD time via `docker build --build-arg`, not left for the
# orchestrator to inject at deploy time — that's what makes /api/version
# answer "which exact image is running" rather than "whatever the
# deployer remembered to set." CI passes the real commit SHA and build
# time. The "unknown" default (not left unset) matters: config.js's
# GIT_SHA/BUILD_TIMESTAMP are `z.string().min(1).optional()` — undefined
# passes, but `ENV GIT_SHA=${GIT_SHA}` with a build-arg that was never
# passed bakes in an EMPTY string, which is optional()'s "present, but
# fails min(1)" case, not its "absent" one, and refuses to boot. Found
# building this image locally without --build-arg, exactly the case a
# new contributor's first `docker build` would hit.
ARG GIT_SHA=unknown
ARG BUILD_TIMESTAMP=unknown
ENV GIT_SHA=${GIT_SHA}
ENV BUILD_TIMESTAMP=${BUILD_TIMESTAMP}
ENV NODE_ENV=production

# package-lock.json, prisma.config.js and prisma/ aren't needed to RUN
# the app (the generated client already inside node_modules is) — they're
# here so docker-compose.yml's `migrate` service (built from this same
# image, `docker compose run --rm migrate`) has something to install the
# Prisma CLI against and a schema/migrations to run it with. Still never
# runs on its own: nothing in this image's default ENTRYPOINT touches any
# of it, only an explicitly different command does.
COPY package.json package-lock.json ./
COPY prisma.config.js ./
COPY prisma ./prisma
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src

# The official image's built-in "node" user (uid/gid 1000) — NFR-2.11's
# non-root requirement. Ownership follows: files copied above land owned
# by root by default, which "node" couldn't read otherwise.
RUN chown -R node:node /app
USER node

# NFR-2.11's read-only rootfs is a RUNTIME flag (`docker run --read-only`
# / compose's `read_only: true`), not something a Dockerfile can force —
# this image is simply built to tolerate it: nothing here writes to the
# image filesystem after this point. Whatever scratch space Node or a
# dependency wants at runtime (os.tmpdir(), effectively /tmp) has to come
# from a tmpfs mount supplied by the runner — docker-compose.yml (repo
# root) does exactly that for local development.

EXPOSE 3000

# Exec form, and `node` directly — never `npm start`. `npm` runs as its
# own process in front of node and does not forward SIGTERM to the child
# by default, which would silently break NFR-3.5's drain-then-exit
# entirely: the container would sit until Docker's own force-kill timeout
# instead of draining. Exec form (no shell) is what lets this be PID 1
# receiving the signal directly, with nothing in between to swallow it.
ENTRYPOINT ["node", "src/index.js"]
