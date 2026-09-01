FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS builder

RUN apk --no-cache add ca-certificates tzdata
WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . ./
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /workbench

FROM alpine:3.22

RUN apk --no-cache add ca-certificates
COPY --from=builder /workbench /workbench
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo

ENV TZ=America/Los_Angeles
EXPOSE 9999
ENTRYPOINT ["/workbench"]
