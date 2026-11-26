FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY src ./src

# Non-root runtime matching k8s PodSecurity restricted baseline
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

CMD ["node", "src/server.js"]
