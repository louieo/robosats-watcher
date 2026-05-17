FROM node:20-alpine

WORKDIR /app
COPY app/package.json app/server.js ./

ENV NODE_ENV=production
ENV CONFIG_PATH=/data/config.json
ENV LISTEN_HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

CMD ["node", "server.js"]
