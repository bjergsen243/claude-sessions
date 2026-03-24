FROM node:22-alpine

WORKDIR /app

COPY server.js index.html scan.js package.json ./

EXPOSE 3456

CMD ["node", "server.js"]
