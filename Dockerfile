FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src src
COPY web web
COPY tsconfig.json index.html tools.json coding-tools.json ./
COPY assets/branding/loop-icon-v1.png assets/branding/loop-icon-v1.png
COPY testdata/ts-average testdata/ts-average
COPY workspace workspace
RUN npm run build
ENV LOOP_PUBLIC=1 PORT=8080
USER 65532:65532
EXPOSE 8080
CMD ["node", "--use-env-proxy", "src/main.ts", "--workspace", "/app/workspace", "--state-dir", "/tmp/loop-runs"]
