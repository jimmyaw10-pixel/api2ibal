FROM mcr.microsoft.com/playwright:v1.50.1-jammy

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json ./
RUN npm install --omit=dev

COPY server.js parse-ibal.js ./
COPY public ./public

EXPOSE 3000
CMD ["npm", "start"]
