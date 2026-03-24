FROM node:22-alpine

WORKDIR /app

COPY server.js index.html package.json ./

EXPOSE 3456

CMD ["node", "server.js"]
