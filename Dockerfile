# JevDeck in one image.
#
# The API serves the built web application as well as `/api`, so an installation is one process on
# one origin: session cookies, CSRF and invitation links all stay same-origin with no proxy to
# configure. The build stage produces `apps/web/dist`; the runtime stage keeps the whole tree so
# `prompts/` and `apps/api/migrations/` are present, because both are read from disk at runtime.
#
# Build:  docker build -t jevdeck .
# Run:    docker run --rm -p 3001:3001 -v jevdeck-data:/data jevdeck
# See docs/self-hosting.md for the environment variables and the backup/restore steps.

FROM oven/bun:1-alpine AS build

WORKDIR /app

# Dependency manifests first, so a source-only change does not re-resolve dependencies.
COPY package.json bun.lock* ./
COPY packages ./packages
COPY apps ./apps
# `prompts/` is read from disk at runtime, resolved relative to the providers package as
# `/app/prompts`. A missing prompt is a hard failure by design, so an image without this line
# builds cleanly and then cannot generate at all.
COPY prompts ./prompts
# The documented backup/restore commands run from the repository root inside the container.
COPY scripts ./scripts

# `--frozen-lockfile` when a lockfile is present: the image resolve must match the repository.
# `.dockerignore` keeps the host's node_modules and build output out of this context, so the
# install resolves for the image rather than reusing host binaries.
RUN if [ -f bun.lock ]; then bun install --frozen-lockfile; else bun install; fi

# Produces the static bundle the API serves. This is a real build, so a type error fails the image
# rather than shipping.
RUN bun --filter "@jevdeck/web" build

FROM oven/bun:1-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    JEVDECK_DB_PATH=/data/jevdeck.sqlite

# The whole tree, including node_modules from the build stage: workspace links resolve inside it.
COPY --from=build /app /app

# The database, and therefore every account, document, deck and review, lives on this volume.
VOLUME ["/data"]

EXPOSE 3001

# Reads the API's own health endpoint, which reports database reachability rather than just
# whether the process is listening.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "const port = process.env.PORT || 3001; const r = await fetch('http://127.0.0.1:' + port + '/api/health'); process.exit(r.ok ? 0 : 1);"

CMD ["bun", "run", "apps/api/src/index.ts"]
