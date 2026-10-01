FROM node:24-alpine
WORKDIR /app
COPY server.mjs ./
COPY config.example.json ./config.json
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
