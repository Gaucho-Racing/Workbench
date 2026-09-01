FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . ./

ARG VITE_API_URL=""
ARG VITE_SENTINEL_URL="https://sso.gauchoracing.com"
ARG VITE_SENTINEL_CLIENT_ID=""

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_SENTINEL_URL=$VITE_SENTINEL_URL
ENV VITE_SENTINEL_CLIENT_ID=$VITE_SENTINEL_CLIENT_ID
RUN npm run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -q --spider http://localhost/ || exit 1

