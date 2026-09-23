FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY *.ts ./
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY --from=builder /app/dist ./dist
COPY server.json ./
COPY scripts ./scripts
ENV PORT=3000
EXPOSE 3000
# Health probe follows PORT and switches to HTTPS when a TLS cert is configured.
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000;const m=process.env.MCP_TLS_CERT_FILE?require('https'):require('http');m.get({host:'127.0.0.1',port:p,path:'/health',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/index.js"]
