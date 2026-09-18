FROM golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac AS build
WORKDIR /src
COPY go.mod ./
COPY *.go index.html tools.json coding-tools.json ./
COPY assets/branding/loop-icon-v1.png assets/branding/loop-icon-v1.png
COPY testdata/go-average testdata/go-average
COPY web/dist web/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /server .

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /server /server
COPY workspace /app/workspace
ENV LOOP_PUBLIC=1
USER 65532:65532
EXPOSE 8080
CMD ["/server", "-workspace", "/app/workspace", "-state-dir", "/tmp/loop-runs"]
