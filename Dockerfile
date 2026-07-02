FROM node:22-alpine

# Non-root runtime
ENV NODE_ENV=production
WORKDIR /app

# Install deps first for layer caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# App source
COPY server ./server
COPY public ./public
COPY test ./test

# hash-wasm UMD bundle is served to the browser from /vendor (see server/index.js)
# It lives in node_modules/hash-wasm/dist and is mounted read-only at runtime.

USER node
EXPOSE 8080
CMD ["node", "server/index.js"]
