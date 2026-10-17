# SKP Valence: a static Vite build served by nginx, which also proxies /api/ to BaseApi so the browser stays same-origin
# (BaseApi has no CORS policy). Build from the repo root:
#   docker build -f src/Valence/Dockerfile -t valence:local .
# Offline, through a registry and npm proxy such as Artifactory (all optional, the defaults are Docker Hub and npmjs):
# --build-arg NODE_IMAGE=<registry>/node:24-alpine --build-arg NGINX_IMAGE=<registry>/nginx:1.29-alpine
# --build-arg NPM_REGISTRY=<npm proxy URL>, and the npm login, if it needs one, as a build secret that is never stored in
# the image: --secret id=npmrc,src=<a .npmrc holding the token>. npm fetches the lock file's packages from NPM_REGISTRY.
ARG NODE_IMAGE=node:24-alpine
ARG NGINX_IMAGE=nginx:1.29-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ARG NPM_REGISTRY=
# .npmrc (legacy-peer-deps=true) must travel with the manifests, as SKP Studio's does.
COPY src/Valence/package.json src/Valence/package-lock.json src/Valence/.npmrc ./
RUN --mount=type=secret,id=npmrc \
    if [ -f /run/secrets/npmrc ]; then export NPM_CONFIG_USERCONFIG=/run/secrets/npmrc; fi; \
    npm ci ${NPM_REGISTRY:+--registry=$NPM_REGISTRY}
COPY src/Valence/ ./
RUN npm run build

FROM ${NGINX_IMAGE}
# nginx.conf is a template (AI drawing, 2026-10-17, as SKP Studio's): at start the image writes it to conf.d/default.conf
# with only these variables filled in, so nginx's own $variables stay: the model's base URL, id and key (env
# KIMI_BASE_URL, KIMI_MODEL_ID, KIMI_API_KEY, set by k8s/32-valence.yaml; any empty: /ai answers 503) and the pod's DNS
# resolvers (the /ai upstream is resolved per request).
ENV KIMI_API_KEY=""     KIMI_BASE_URL=""     KIMI_MODEL_ID=""     NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    NGINX_ENVSUBST_FILTER="^(KIMI_API_KEY|KIMI_BASE_URL|KIMI_MODEL_ID|NGINX_LOCAL_RESOLVERS)$"
COPY src/Valence/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
