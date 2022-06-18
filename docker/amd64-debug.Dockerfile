FROM amd64/node:16-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    curl \
    && rm -rf /var/lib/apt/lists/*

ENV WORKINGDIR /app
WORKDIR ${WORKINGDIR}

ADD package.json ${WORKINGDIR}/package.json
ADD .eslintrc.json ${WORKINGDIR}/.eslintrc.json
ADD tsconfig.json ${WORKINGDIR}/tsconfig.json
ADD scripts ${WORKINGDIR}/scripts
ADD src ${WORKINGDIR}/src

RUN npm install -q \
    && npm run build \
    && npm run eslint \
    && npm prune --production \
    && rm -f .eslintrc.json \
    && rm -f tsconfig.json \
    && rm -rf scripts \
    && rm -rf srce

HEALTHCHECK \
    --interval=30s \
    --timeout=30s \
    --start-period=60s \
    --retries=3 \
    CMD curl -f http://localhost:9070/health || exit 1

EXPOSE 9229

CMD ["node", "--inspect=0.0.0.0:9229", "./dist/index"]
