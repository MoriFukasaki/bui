FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.mjs recordings.mjs database.mjs env.mjs ice.mjs room-owner.mjs ./
COPY public ./public
COPY migrations ./migrations
COPY scripts/migrate.mjs ./scripts/migrate.mjs
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["npm", "start"]
