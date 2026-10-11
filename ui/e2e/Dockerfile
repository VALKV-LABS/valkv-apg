# Browser tests of the console. The image version must match @playwright/test in package.json.
FROM mcr.microsoft.com/playwright:v1.49.1-noble
WORKDIR /e2e
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY playwright.config.ts ./
COPY tests ./tests
CMD ["npx", "playwright", "test"]
