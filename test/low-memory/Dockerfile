FROM node:22.19-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git python3 time \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global npm@11.19.1

WORKDIR /workspace

COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY . .
RUN npm run build

ENTRYPOINT ["./test/low-memory/entrypoint.sh"]
CMD ["e2e"]
