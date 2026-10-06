# SKP Studio: a static Vite build served by nginx, which also proxies /api/ to BaseApi so the
# browser stays same-origin (BaseApi has no CORS policy). Build from the repo root:
#   docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .
FROM node:24-alpine AS build
WORKDIR /app
# .npmrc (legacy-peer-deps=true) must travel with the manifests: it works around an npm 10.9.2
# crash in the peer-set resolver that the pinned dependency set triggers.
COPY src/WorkflowStudio/package.json src/WorkflowStudio/package-lock.json src/WorkflowStudio/.npmrc ./
RUN npm ci
COPY src/WorkflowStudio/ ./
RUN npm run build

FROM nginx:1.29-alpine
COPY src/WorkflowStudio/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
