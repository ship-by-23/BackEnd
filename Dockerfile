FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S nodejs && adduser -S simpandulu -G nodejs
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force \
    && rm -r /usr/local/lib/node_modules/npm \
    && rm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build --chown=simpandulu:nodejs /app/dist ./dist
COPY --chown=simpandulu:nodejs drizzle ./drizzle
USER simpandulu
EXPOSE 3000
CMD ["node", "dist/server.js"]
