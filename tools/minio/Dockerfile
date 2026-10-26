# The dev S3 endpoint for ObjectFetcher and ObjectPersister: MinIO and its client, built from upstream
# source at pinned release tags. Run it with tools/minio-dev.ps1, never by hand.
#
#   docker build -t skp-minio:local tools/minio
#
# BUILT FROM SOURCE BECAUSE THERE IS NO IMAGE TO PULL (2026-10-26). MinIO stopped publishing
# community images: minio/minio is gone from Docker Hub and quay.io/minio answers 401. The source is
# still public, so the server and mc are compiled here from their last release tags. The two
# alternatives were rejected: bitnamilegacy/minio is frozen with no further updates, and the
# pgsty/minio fork publishes mc only as `latest`, so the client could not be pinned.
#
# THE PINS ARE THE TAGS BELOW, AND THEY ARE ALL THERE IS. These are the final upstream releases; a
# newer one will not appear, so there is nothing to track. Go 1.24.8 is the toolchain both go.mod
# files ask for (minio: go1.24.8; mc: go1.23.10, which 1.24 builds).
#
# THE TARGET IS S3, NOT THIS. Nothing in the processors knows it is MinIO: they get S3__ServiceUrl and
# S3__ForcePathStyle from configuration and talk plain S3. See
# docs/superpowers/specs/2026-10-26-object-fetcher-persister-design.md §2.
FROM golang:1.24.8-bookworm AS build
ARG MINIO_TAG=RELEASE.2025-10-15T17-29-55Z
ARG MC_TAG=RELEASE.2025-08-13T08-35-41Z
ENV CGO_ENABLED=0
WORKDIR /src

# gen-ldflags stamps the release time and commit into the binary: `minio --version` prints
# DEVELOPMENT.2025-10-15T17-29-55Z (commit-id=9e49d5e…). The DEVELOPMENT prefix is upstream's word for
# any build not made by their release pipeline; the time and commit are the tag's. It takes the
# release time, which is the tag with its dashes restored.
RUN git clone --quiet --depth 1 --branch "$MINIO_TAG" https://github.com/minio/minio.git minio \
 && cd minio \
 && v=$(echo "$MINIO_TAG" | sed -E 's/^RELEASE\.//; s/T([0-9]{2})-([0-9]{2})-([0-9]{2})Z$/T\1:\2:\3Z/') \
 && MINIO_RELEASE=RELEASE go build -trimpath -tags kqueue -ldflags "$(go run buildscripts/gen-ldflags.go "$v")" -o /out/minio .

RUN git clone --quiet --depth 1 --branch "$MC_TAG" https://github.com/minio/mc.git mc \
 && cd mc \
 && v=$(echo "$MC_TAG" | sed -E 's/^RELEASE\.//; s/T([0-9]{2})-([0-9]{2})-([0-9]{2})Z$/T\1:\2:\3Z/') \
 && MC_RELEASE=RELEASE go build -trimpath -ldflags "$(go run buildscripts/gen-ldflags.go "$v")" -o /out/mc .

# mc ships IN the server image, so the bucket and user setup runs as `docker exec skp-minio mc ...`
# and needs no second container. ca-certificates only for mc's own TLS paths; the dev endpoint is http.
FROM debian:bookworm-20251229-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/minio /out/mc /usr/local/bin/
EXPOSE 9000 9001
VOLUME ["/data"]
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
