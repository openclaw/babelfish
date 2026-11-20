FROM node:22.23.4-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git openssh-client python3 time \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global npm@11.19.1

WORKDIR /workspace

COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY test/consumer-tools/package.json test/consumer-tools/package-lock.json /consumer-tools/
RUN cd /consumer-tools && npm ci --ignore-scripts --no-audit --no-fund
ENV BABELFISH_CONSUMER_TOOLS=/consumer-tools BABELFISH_CONSUMER_OFFLINE=1 BABELFISH_CONSUMER_CACHE=/root/.npm npm_config_cache=/root/.npm

COPY . .
RUN npm run build
# Warm the production dependency graph for the fresh offline install in the 1 GiB tier.
RUN npm install --prefix /tmp/package-consumer --install-links --omit=dev --ignore-scripts --no-audit --no-fund /workspace \
  && rm -rf /tmp/package-consumer

ENTRYPOINT ["./test/low-memory/entrypoint.sh"]
CMD ["e2e"]
