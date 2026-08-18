FROM node:20-alpine AS builder

ARG VERSION=vdev
ARG BUILD_TIME=timeless
ARG COMMIT_HASH=sha-unknown
ENV VITE_APP_VERSION=$VERSION
ENV VITE_APP_BUILD_TIME=$BUILD_TIME
ENV VITE_APP_COMMIT_HASH=$COMMIT_HASH

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY default.conf.template /etc/nginx/templates/default.conf.template

ENV BACKEND_HOST=backend
ENV BACKEND_PORT=8080

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
