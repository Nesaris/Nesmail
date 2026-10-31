# syntax=docker/dockerfile:1
# Nesmail 2 : Node seul, aucune dépendance d'exécution (node:sqlite et Argon2id
# sont dans le moteur). L'image de base est épinglée par empreinte (index
# multi-architecture amd64 + arm64) : une étiquette peut être déplacée, une
# empreinte non.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

FROM ${NODE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 nesmail && useradd -u 10001 -g nesmail -M -d /nonexistent -s /usr/sbin/nologin nesmail
WORKDIR /app
COPY package.json nouveautes.json server.js ./
COPY socle ./socle
COPY lib ./lib
COPY public ./public
RUN mkdir -p /data && chown nesmail:nesmail /data && chmod 700 /data
USER nesmail
ENV NODE_ENV=production NESMAIL_DATA=/data PORT=8787 TZ=UTC
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
