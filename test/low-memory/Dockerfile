FROM node:22.19-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git python3 time \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global npm@11.19.1

WORKDIR /workspace

COPY package.json package-lock.json .npmrc ./
RUN npm ci

RUN npm install --prefix /consumer-tools --ignore-scripts --no-audit --no-fund --save-exact typescript@7.0.2 @types/node@26.6.3
ENV BABELFISH_CONSUMER_TOOLS=/consumer-tools BABELFISH_CONSUMER_OFFLINE=1 BABELFISH_CONSUMER_CACHE=/root/.npm npm_config_cache=/root/.npm

COPY . .
RUN npm run build
RUN BABELFISH_CONSUMER_OFFLINE=0 npm run pack:check

ENTRYPOINT ["./test/low-memory/entrypoint.sh"]
CMD ["e2e"]
