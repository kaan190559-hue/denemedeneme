FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=10000
ENV BOZOK_DATA_DIR=/data
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /data

EXPOSE 10000

CMD ["npm", "start"]
