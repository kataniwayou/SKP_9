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
# nginx.conf is a template (AI drawing, 2026-10-11): at start the image writes it to conf.d/default.conf with only these
# variables filled in, so nginx's own $variables stay: the model key (from the skp-ai Secret; empty: /ai answers 503)
# and the pod's DNS resolvers (the /ai upstream is resolved per request).
ENV KIMI_API_KEY=""     NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1     NGINX_ENVSUBST_FILTER="^(KIMI_API_KEY|NGINX_LOCAL_RESOLVERS)$"
COPY src/WorkflowStudio/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
