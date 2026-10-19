# SKP Studio: build and deploy by hand on an offline machine

This manual builds the SKP Studio image and deploys it on a machine with no internet, one command at a time, with no
scripts. The source is the repo's own (`src\WorkflowStudio`), the deployment is the repo's own
(`k8s\31-workflow-studio.yaml`), and this folder holds everything third-party the build needs: every npm package and the
two base images. No ready-made Studio image is shipped; the offline machine builds it.

The commands work the same in PowerShell 7 and in a Linux shell, and every one runs **from the repo root** (the folder
holding `src`, `k8s` and this `Studio-offline`). Run each command, check its result as shown, and go on only when it
matches.

## What it uses

| Path | What it is |
|---|---|
| `Studio-offline\npm-offline\` | Every npm package the build installs (184 `.tgz`, 82 MB), each matching `src\WorkflowStudio\package-lock.json`'s checksum. Tracked in git |
| `Studio-offline\images\node-24-alpine.tar` | The build stage's base image (`node:24-alpine`). Not in git: carry it beside the repo |
| `Studio-offline\images\nginx-1.29-alpine.tar` | The served image's base (`nginx:1.29-alpine`). Not in git |
| `Studio-offline\images\SHA256SUMS.txt` | The two tars' checksums |
| `src\WorkflowStudio\` | The Studio's source and its `Dockerfile` |
| `k8s\00-namespace.yaml`, `k8s\31-workflow-studio.yaml` | The `skp` namespace; the Studio's Service and Deployment, with its settings |
| `.dockerignore` | Keeps local build output (`node_modules`, `dist`, the image tars) out of the build |

The two tars are the same files as in `Valence-offline\images\`; if you deploy both, load them once.

---

## Step 0. What the machine needs

- Docker 23 or newer: `docker version` shows the Server version.
- kubectl pointed at the cluster: `kubectl config current-context` shows it.
- For a kind cluster, `kind`: `kind get clusters` lists it.
- No Node.js, npm or internet. The build runs inside Docker.

**In the cluster:** namespace `skp`, with BaseApi running as service `baseapi-service` on port 8080 (or set its address
in step 6). The Studio reads and saves workflows through it; without it the Studio opens but can't load anything.

## Step 1. Bring the repo over and check it

Bring the repo at branch `feature/molecule-studio` (through git, or as a folder copy), **plus** the two tars in
`Studio-offline\images\`, which git doesn't carry. A folder copy needn't include `node_modules`, `dist` or
`test-results`. If you copy a working folder, first empty the keys in `k8s\31-workflow-studio.yaml` and
`k8s\32-valence.yaml` (`KIMI_API_KEY`) and `k8s\43-processor-analyst.yaml` (`Analyst__Model__ApiKey`): a working copy
may hold real keys that git never sees.

Check the commit:

```
git log --oneline -1
```

**Expect:** the commit you were told. Then check the tars.

**PowerShell:**

```powershell
Get-Content Studio-offline/images/SHA256SUMS.txt | ForEach-Object { $h, $f = $_ -split '\s+\*?', 2
  if ((Get-FileHash "Studio-offline/images/$f" -Algorithm SHA256).Hash.ToLower() -ne $h) { "DAMAGED: $f" } }
```

**Linux:**

```bash
(cd Studio-offline/images && sha256sum -c --quiet SHA256SUMS.txt)
```

**Expect:** no output. A file named in the output is damaged; copy it again.

## Step 2. Load the base images

Skip this step if your registry (Artifactory or another) already holds `node:24-alpine` and `nginx:1.29-alpine`. Use
the registry's names in step 3 instead.

```
docker load -i Studio-offline/images/node-24-alpine.tar
docker load -i Studio-offline/images/nginx-1.29-alpine.tar
```

**Expect:** `Loaded image: node:24-alpine` and `Loaded image: nginx:1.29-alpine`.

## Step 3. Build the image

```
docker build --network=none -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .
```

The final `.` is the repo root, which the build reads from. `--network=none` proves that nothing comes from the network.
The build:
1. copies `Studio-offline\npm-offline\` into an empty npm cache;
2. runs `npm ci --offline`, which installs the exact versions in `package-lock.json` from that cache alone;
3. runs `npm run build`, which type-checks and compiles the page;
4. copies the result into nginx.

It takes a minute or two.

**Expect:** the last lines name `workflow-studio:local`, with no `ERROR`. A warning about `KIMI_API_KEY` in an `ENV`
line is expected: the Dockerfile only sets it empty.

**With base images from a registry** instead of step 2, name them, and leave out `--network=none` so Docker can pull them:

```
docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local --build-arg NODE_IMAGE=art.example.com/docker/node:24-alpine --build-arg NGINX_IMAGE=art.example.com/docker/nginx:1.29-alpine .
```

If the build fails with `npm error code ENOTCACHED` naming a package, that package is missing from
`Studio-offline\npm-offline\`: the repo's lock file and the folder are out of step. On a machine with internet run
`node tools/vendor-npm.mjs studio`, commit, and bring the repo over again.

## Step 4. Try the image on its own (optional)

```
docker run -d --rm --name studio-try -p 18091:8080 --add-host baseapi-service:127.0.0.1 workflow-studio:local
```

Then open `http://localhost:18091/healthz`; **expect** `ok`. Open `http://localhost:18091/`; **expect** the Studio, with
the menu strip *Workflow · Edit · View · Window*. It can't load workflows here, which is expected. Stop it with:

```
docker stop studio-try
```

The `--add-host` part is needed because nginx looks up `baseapi-service` when it starts, and that name exists only
inside the cluster.

## Step 5. Get the image to the cluster

Do **one** of these.

**A) kind:** copy the image into the cluster's nodes:

```
kind load docker-image workflow-studio:local --name <cluster name>
```

**B) A cluster that pulls from a registry:** tag the image with the registry's name and a version, and push it:

```
docker login art.example.com
docker tag workflow-studio:local art.example.com/docker-local/skp/workflow-studio:1.0.0
docker push art.example.com/docker-local/skp/workflow-studio:1.0.0
```

If the cluster needs a login to pull, create the pull secret once:

```
kubectl -n skp create secret docker-registry artifactory --docker-server=art.example.com --docker-username=<user> --docker-password=<token>
```

## Step 6. Settings in the deployment file

Open `k8s\31-workflow-studio.yaml` in an editor.

- **The image.** A) kind: leave `image: workflow-studio:local`. B) registry: change it to
  `image: art.example.com/docker-local/skp/workflow-studio:1.0.0`; if you made a pull secret, add these two lines just
  above `containers:`, at the same indent:

  ```yaml
      imagePullSecrets:
        - name: artifactory
  ```

- **BaseApi's address, `BASEAPI_URL`.** As shipped, `http://baseapi-service:8080`, the cluster's BaseApi service. Change
  it only if BaseApi runs under another name, namespace (`http://<name>.<namespace>:8080`) or port. Scheme, host and
  port only: no path and no trailing slash. It must not be empty, or the pod won't start. It serves both `/api/` and
  the live-update hub `/api/hubs/`.

- **The AI wand (optional):** `KIMI_BASE_URL`, `KIMI_MODEL_ID` and `KIMI_API_KEY`. With the key empty, as shipped, the
  wand says "AI drawing is not configured", and everything else works. Offline, Moonshot can't be reached; to use a
  model inside your network:
  - set `KIMI_BASE_URL` to an OpenAI-compatible server, without `/chat/completions` (`http://` is fine);
  - set `KIMI_MODEL_ID` to its model name;
  - set `KIMI_API_KEY` to its key, or any non-empty value if it needs none.

  It must accept streamed `/chat/completions` with `response_format: {"type":"json_object"}` and `reasoning_effort`, or
  ignore them. Don't commit or share the file once it holds a key.

## Step 7. Deploy

Check that BaseApi is there, then check the deployment without changing anything:

```
kubectl -n skp get svc baseapi-service
kubectl apply --dry-run=server -f k8s/00-namespace.yaml
kubectl apply --dry-run=server -f k8s/31-workflow-studio.yaml
```

**Expect:** the service is listed, then lines ending in `(server dry run)` and no error. Then apply for real:

```
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/31-workflow-studio.yaml
kubectl -n skp rollout status deploy/workflow-studio
```

**Expect:** `deployment "workflow-studio" successfully rolled out`. If the Studio was deployed before under the same
image name (such as `workflow-studio:local` on kind), also run `kubectl -n skp rollout restart deploy/workflow-studio`,
then the `rollout status` line again.

Check the pod:

```
kubectl -n skp get pods -l app=workflow-studio
```

**Expect:** `1/1 Running`. If not, `kubectl -n skp describe pod -l app=workflow-studio` says why. See the table at the
end.

## Step 8. Open the Studio and check

```
kubectl -n skp port-forward svc/workflow-studio 18081:8080
```

Leave it running, and browse to **http://localhost:18081**. Then check:

- `http://localhost:18081/healthz` answers `ok`;
- *Workflow › Load…* lists the workflows (BaseApi is reachable);
- `http://localhost:18081/ai/config` answers `{"model":"..."}` when the wand is configured, 503 when off.

**Browser:** a recent Chrome, Edge or Firefox, with WebSockets, local storage and pop-up windows allowed for the Studio.
Nothing to install.

---

## Later

- **Change a setting:** edit `k8s\31-workflow-studio.yaml`, then repeat step 7's
  `kubectl apply -f k8s/31-workflow-studio.yaml`. The pod restarts by itself.
- **A changed source:** bring the repo over again, build (step 3), and for a registry push with a new version
  (`1.0.1`, ...), set it in step 6, and repeat step 7. Refresh open Studio tabs with Ctrl+F5.
- **Remove:** `kubectl -n skp delete deploy/workflow-studio svc/workflow-studio`. Leave the namespace, because BaseApi
  uses it.

## Keeping this folder up to date (on a machine with internet)

After any change to `src\WorkflowStudio\package-lock.json`:

```
node tools/vendor-npm.mjs studio           # download what is missing, remove what the lock file no longer names
node tools/vendor-npm.mjs studio --check   # only check: every package present and matching
```

and commit `Studio-offline\npm-offline\` with the lock file. For a compile outside Docker on a machine with Node.js
(`>=22.12`) but no registry, `node tools/vendor-npm.mjs studio --install` runs `npm ci --offline` in
`src\WorkflowStudio` from this folder alone; on Windows then run `npm run build` from PowerShell or cmd, not Git Bash
(npm starts scripts through `cmd.exe`). Two build tools ship a native part per platform (`@rolldown/binding-*`,
`lightningcss-*`); only Linux x64 and arm64 (musl and glibc) and Windows x64 are kept.

The tars come from `docker pull node:24-alpine`, `docker pull nginx:1.29-alpine`, then
`docker save -o Studio-offline/images/node-24-alpine.tar node:24-alpine` (and the same for nginx), followed by a new
`SHA256SUMS.txt` (`sha256sum *.tar > SHA256SUMS.txt` in `images`).

## When something goes wrong

| What you see | Why, and what to do |
|---|---|
| Step 1 names a tar | The copy is damaged. Copy that file again. |
| Step 3: `pull access denied` / `failed to resolve source metadata` for node or nginx | The base image isn't loaded. Do step 2, or name your registry's images. |
| Step 3: `npm error code ENOTCACHED` | A package is missing from `Studio-offline\npm-offline\`. See step 3. |
| Step 3: `"/Studio-offline/npm-offline": not found` | The build didn't run from the repo root, or the repo is older than this kit. |
| Pod `ErrImagePull` / `ImagePullBackOff` | The cluster can't find the image. On kind, do step 5A. With a registry, check the name in step 6 and the pull secret. |
| Pod `CrashLoopBackOff`, log says `host not found in upstream "baseapi-service"` | BaseApi's service isn't in namespace `skp`. Check with `kubectl -n skp get svc baseapi-service`, or set `BASEAPI_URL` (step 6). |
| Pod `CrashLoopBackOff`, log says `invalid number of arguments in "proxy_pass"` | `BASEAPI_URL` is empty. Set it (step 6). |
| Pod crashes on OpenShift with permission errors | The image runs nginx as root, which OpenShift's default policy forbids; build with `--build-arg NGINX_IMAGE=<registry>/nginxinc/nginx-unprivileged:1.29-alpine`, or allow the pod to run as root. Not tested. |
| Load… is empty or errors | BaseApi isn't running in `skp`: `kubectl -n skp get svc baseapi-service`. |
| Live status never updates | Something between the browser and the Studio blocks WebSockets to `/api/hubs/`. |
| The wand: "AI drawing is not configured" | As shipped. See step 6. |
