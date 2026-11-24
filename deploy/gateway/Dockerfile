FROM node:24-slim AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/agent/package.json packages/agent/
COPY packages/connectors/package.json packages/connectors/
COPY packages/mock/package.json packages/mock/
COPY packages/gateway/package.json packages/gateway/
RUN pnpm install --frozen-lockfile
COPY packages/ packages/
RUN pnpm build && pnpm --filter @homemcp/gateway --prod deploy /prod/gateway

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd -g 1000 homemcp || true && useradd -u 1000 -g 1000 -m homemcp || true
COPY --from=builder --chown=1000:1000 /prod/gateway /app
COPY --chown=1000:1000 templates/ /app/templates/
COPY --chown=1000:1000 docs/runbooks/ /app/docs/runbooks/
USER 1000:1000
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8790/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "--no-warnings=ExperimentalWarning", "/app/dist/cli.js"]
CMD ["serve", "--transport", "http", "--config", "/config/homemcp.config.yaml"]
