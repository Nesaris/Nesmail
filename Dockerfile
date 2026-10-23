FROM node:22-alpine
RUN apk add --no-cache tzdata && adduser -D -u 10001 cachet
ENV TZ=UTC NODE_ENV=production CACHET_DATA=/data
WORKDIR /app
COPY --chown=cachet:cachet package.json server.js ./
COPY --chown=cachet:cachet lib ./lib
COPY --chown=cachet:cachet public ./public
RUN mkdir -p /data && chown cachet:cachet /data
USER cachet
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8787/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
