# SKP Studio: a static Vite build served by nginx, which also proxies /api/ to BaseApi so the
# browser stays same-origin (BaseApi has no CORS policy). Build from the repo root:
#   docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .
# The npm packages come only from Studio-offline/npm-offline/ (2026-10-12; in the kit since 2026-10-19), the npm
# counterpart of nugets/: the build never reaches an npm registry, and a package missing there fails it by name
# (node tools/vendor-npm.mjs studio keeps the folder in step with the lock file). The base images are build settings,
# for a registry such as Artifactory (defaults: Docker Hub, or the tars in Studio-offline/images/ loaded into Docker):
# --build-arg NODE_IMAGE=<registry>/node:24-alpine --build-arg NGINX_IMAGE=<registry>/nginx:1.29-alpine
ARG NODE_IMAGE=node:24-alpine
ARG NGINX_IMAGE=nginx:1.29-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# .npmrc (legacy-peer-deps=true) must travel with the manifests: it works around an npm 10.9.2
# crash in the peer-set resolver that the pinned dependency set triggers.
COPY src/WorkflowStudio/package.json src/WorkflowStudio/package-lock.json src/WorkflowStudio/.npmrc ./
COPY Studio-offline/npm-offline/ /npm-offline/
# the folder's tarballs into an empty cache, then the lock file installed from that cache alone
RUN npm cache add /npm-offline/*.tgz --cache /tmp/npm-cache --loglevel=warn \
    && npm ci --offline --cache /tmp/npm-cache --no-audit --no-fund \
    && rm -rf /tmp/npm-cache /npm-offline
COPY src/WorkflowStudio/ ./
RUN npm run build

FROM ${NGINX_IMAGE}
# nginx.conf is a template (the chat's model, 2026-10-11): at start the image writes it to conf.d/default.conf with only these
# variables filled in, so nginx's own $variables stay: the model's base URL, id and key (env KIMI_BASE_URL,
# KIMI_MODEL_ID, KIMI_API_KEY, set by k8s/31-workflow-studio.yaml; any empty: /ai answers 503) and the pod's DNS
# resolvers (the /ai upstream is resolved per request).
# BaseApi's address (env BASEAPI_URL, 2026-10-18; k8s/31-workflow-studio.yaml): scheme, host and port only, looked up when nginx
# starts; the default is the cluster's service.
ENV BASEAPI_URL="http://baseapi-service:8080" \
    KIMI_API_KEY=""     KIMI_BASE_URL=""     KIMI_MODEL_ID=""     NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    NGINX_ENVSUBST_FILTER="^(BASEAPI_URL|KIMI_API_KEY|KIMI_BASE_URL|KIMI_MODEL_ID|NGINX_LOCAL_RESOLVERS)$"
COPY src/WorkflowStudio/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
