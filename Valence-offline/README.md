# SKP Valence: build and deploy by hand on an offline machine

This manual builds the SKP Valence image and deploys it on a machine with no internet, one command at a time, with no
scripts. The source is the repo's own (`src\Valence`), the deployment is the repo's own (`k8s\32-valence.yaml`), and this
folder holds everything third-party the build needs: every npm package and the two base images. No ready-made Valence
image is shipped; the offline machine builds it.

The commands work the same in PowerShell 7 and in a Linux shell, and every one runs **from the repo root** (the folder
holding `src`, `k8s` and this `Valence-offline`). Windows PowerShell 5.1 passes the quotes in step 8 wrongly. Run each
command, check its result as shown, and go on only when it matches.

## What it uses

| Path | What it is |
|---|---|
| `Valence-offline\npm-offline\` | Every npm package the build installs (124 `.tgz`, 81 MB), each matching `src\Valence\package-lock.json`'s checksum. Tracked in git |
| `Valence-offline\images\node-24-alpine.tar` | The build stage's base image (`node:24-alpine`). Not in git: carry it beside the repo |
| `Valence-offline\images\nginx-1.29-alpine.tar` | The served image's base (`nginx:1.29-alpine`). Not in git |
| `Valence-offline\images\SHA256SUMS.txt` | The two tars' checksums |
| `src\Valence\` | Valence's source and its `Dockerfile` |
| `k8s\00-namespace.yaml`, `k8s\32-valence.yaml` | The `skp` namespace; Valence's Service and Deployment, with its settings |
| `.dockerignore` | Keeps local build output (`node_modules`, `dist`, the image tars) out of the build |

`src\Valence` also holds Valence's unit tests (`*.test.ts`). The build type-checks them but doesn't run them.

---

## Step 0. What the machine needs

- Docker 23 or newer: `docker version` shows the Server version.
- kubectl pointed at the cluster: `kubectl config current-context` shows it.
- For a kind cluster, `kind`: `kind get clusters` lists it.
- No Node.js, npm or internet. The build runs inside Docker.

**In the cluster:** namespace `skp`, with BaseApi running as service `baseapi-service` on port 8080 (or set its address
in step 6). How much of Valence works depends on that BaseApi. Step 8 checks it.

## Step 1. Bring the repo over and check it

Bring the repo at branch `feature/molecule-studio` (through git, or as a folder copy), **plus** the two tars in
`Valence-offline\images\`, which git doesn't carry. A folder copy needn't include `node_modules`, `dist` or
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
Get-Content Valence-offline/images/SHA256SUMS.txt | ForEach-Object { $h, $f = $_ -split '\s+\*?', 2
  if ((Get-FileHash "Valence-offline/images/$f" -Algorithm SHA256).Hash.ToLower() -ne $h) { "DAMAGED: $f" } }
```

**Linux:**

```bash
(cd Valence-offline/images && sha256sum -c --quiet SHA256SUMS.txt)
```

**Expect:** no output. A file named in the output is damaged; copy it again.

## Step 2. Load the base images

Skip this step if your registry (Artifactory or another) already holds `node:24-alpine` and `nginx:1.29-alpine`. Use
the registry's names in step 3 instead.

```
docker load -i Valence-offline/images/node-24-alpine.tar
docker load -i Valence-offline/images/nginx-1.29-alpine.tar
```

**Expect:** `Loaded image: node:24-alpine` and `Loaded image: nginx:1.29-alpine`.

## Step 3. Build the image

```
docker build --network=none -f src/Valence/Dockerfile -t valence:local .
```

The final `.` is the repo root, which the build reads from. `--network=none` proves that nothing comes from the network.
The build:
1. copies `Valence-offline\npm-offline\` into an empty npm cache;
2. runs `npm ci --offline`, which installs the exact versions in `package-lock.json` from that cache alone;
3. runs `npm run build`, which type-checks and compiles the page;
4. copies the result into nginx.

It takes about a minute.

**Expect:** the last lines name `valence:local`, with no `ERROR`. A warning about `KIMI_API_KEY` in an `ENV` line is
expected: the Dockerfile only sets it empty.

**With base images from a registry** instead of step 2, name them, and leave out `--network=none` so Docker can pull them:

```
docker build -f src/Valence/Dockerfile -t valence:local --build-arg NODE_IMAGE=art.example.com/docker/node:24-alpine --build-arg NGINX_IMAGE=art.example.com/docker/nginx:1.29-alpine .
```

If the build fails with `npm error code ENOTCACHED` naming a package, that package is missing from
`Valence-offline\npm-offline\`: the repo's lock file and the folder are out of step. On a machine with internet run
`node tools/vendor-npm.mjs valence`, commit, and bring the repo over again.

## Step 4. Try the image on its own (optional)

```
docker run -d --rm --name valence-try -p 18093:8080 --add-host baseapi-service:127.0.0.1 valence:local
```

Then open `http://localhost:18093/healthz`; **expect** `ok`. Open `http://localhost:18093/`; **expect** the page titled
"SKP Valence". It can't read a project here, which is expected. Stop it with:

```
docker stop valence-try
```

The `--add-host` part is needed because nginx looks up `baseapi-service` when it starts, and that name exists only
inside the cluster.

## Step 5. Get the image to the cluster

Do **one** of these.

**A) kind:** copy the image into the cluster's nodes:

```
kind load docker-image valence:local --name <cluster name>
```

**B) A cluster that pulls from a registry:** tag the image with the registry's name and a version, and push it:

```
docker login art.example.com
docker tag valence:local art.example.com/docker-local/skp/valence:1.0.0
docker push art.example.com/docker-local/skp/valence:1.0.0
```

If the cluster needs a login to pull, create the pull secret once:

```
kubectl -n skp create secret docker-registry artifactory --docker-server=art.example.com --docker-username=<user> --docker-password=<token>
```

## Step 6. Settings in the deployment file

Open `k8s\32-valence.yaml` in an editor.

- **The image.** A) kind: leave `image: valence:local`. B) registry: change it to
  `image: art.example.com/docker-local/skp/valence:1.0.0`; if you made a pull secret, add these two lines just above
  `containers:`, at the same indent:

  ```yaml
      imagePullSecrets:
        - name: artifactory
  ```

- **BaseApi's address, `BASEAPI_URL`.** As shipped, `http://baseapi-service:8080`, the cluster's BaseApi service. Change
  it only if BaseApi runs under another name, namespace (`http://<name>.<namespace>:8080`) or port. Scheme, host and
  port only: no path and no trailing slash. It must not be empty, or the pod won't start.

- **The chat (optional):** `KIMI_BASE_URL`, `KIMI_MODEL_ID` and `KIMI_API_KEY`. With the key empty, as shipped, the
  Chat pane says "The chat is not configured", and everything else works. To use a model inside your network:
  - set `KIMI_BASE_URL` to an OpenAI-compatible server, without `/chat/completions`;
  - set `KIMI_MODEL_ID` to its model name;
  - set `KIMI_API_KEY` to its key, or any non-empty value if it needs none.

  It must accept streamed `/chat/completions` with `response_format: {"type":"json_object"}`, or ignore it. Don't
  commit or share the file once it holds a key.

## Step 7. Deploy

Check first, without changing anything:

```
kubectl apply --dry-run=server -f k8s/00-namespace.yaml
kubectl apply --dry-run=server -f k8s/32-valence.yaml
```

**Expect:** lines ending in `(server dry run)` and no error. Then apply for real:

```
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/32-valence.yaml
kubectl -n skp rollout status deploy/valence
```

**Expect:** `deployment "valence" successfully rolled out`. If Valence was deployed before under the same image name
(such as `valence:local` on kind), also run `kubectl -n skp rollout restart deploy/valence`, then the `rollout status`
line again.

Check the pod:

```
kubectl -n skp get pods -l app=valence
```

**Expect:** `1/1 Running`. If not, `kubectl -n skp describe pod -l app=valence` says why. See the table at the end.

## Step 8. Check what BaseApi offers Valence

These calls run from inside the Valence pod. They only read: the dry run is sent with no changes, so nothing is written.
If you changed `BASEAPI_URL`, use that address instead of `http://baseapi-service:8080`.

```
kubectl -n skp exec deploy/valence -- wget -q -O /dev/null http://baseapi-service:8080/api/v1/workflows
kubectl -n skp exec deploy/valence -- wget -q -O /dev/null http://baseapi-service:8080/api/v1/model/fields
kubectl -n skp exec deploy/valence -- wget -q -O - --header=Content-Type:application/json --post-data='{"changes":[]}' http://baseapi-service:8080/api/v1/model/validate
```

A call that prints nothing (or, for the last one, `{"ok":true,"results":[]}`) means **yes**. One that prints
`wget: server returned error` means **no**.

| Call | If yes | If no |
|---|---|---|
| `workflows` | Valence reads the project | Valence can't open: BaseApi isn't running in `skp` |
| `model/fields` | Valence uses this BaseApi's own field rules | Valence uses its bundled copy, and the Output pane says so |
| `model/validate` | BaseApi checks every change, and **Apply** writes them | **Apply** stays greyed, so nothing can be written. You can still view and edit the molecule |

The `/model` endpoints exist only in a BaseApi built from branch `feature/molecule-studio`. A BaseApi from `main` lacks
them. BaseApi is built and deployed separately.

## Step 9. Open Valence

```
kubectl -n skp port-forward svc/valence 18082:8080
```

Leave it running, and browse to **http://localhost:18082**. Then check:

- `http://localhost:18082/healthz` answers `ok`.
- The canvas draws the project's molecule, and the Output pane says where the rules came from.
- The processors' atoms glow green or red by their health; grey means not known.
- `http://localhost:18082/ai/config` answers 503 while the chat is off, as shipped, or `{"model":"..."}` once it's set.

**Browser:** a recent Chrome, Edge or Firefox, with WebGL and local storage allowed. Nothing to install.

Valence keeps the drawing and your unapplied changes only in the browser. Nothing in the cluster holds them, and nothing
is written to BaseApi except by **Apply**.

---

## Later

- **Change a setting:** edit `k8s\32-valence.yaml`, then repeat step 7's `kubectl apply -f k8s/32-valence.yaml`. The
  pod restarts by itself.
- **A changed source:** bring the repo over again, build (step 3), and for a registry push with a new version
  (`1.0.1`, ...), set it in step 6, and repeat step 7. Refresh open Valence tabs with Ctrl+F5.
- **Remove:** `kubectl -n skp delete deploy/valence svc/valence`. Leave the namespace, because BaseApi uses it.

## Keeping this folder up to date (on a machine with internet)

After any change to `src\Valence\package-lock.json`:

```
node tools/vendor-npm.mjs valence           # download what is missing, remove what the lock file no longer names
node tools/vendor-npm.mjs valence --check   # only check: every package present and matching
```

and commit `Valence-offline\npm-offline\` with the lock file. For a compile outside Docker on a machine with Node.js
(`>=22.12`) but no registry, `node tools/vendor-npm.mjs valence --install` runs `npm ci --offline` in `src\Valence` from
this folder alone. Two build tools ship a native part per platform; only Linux x64 and arm64 (musl and glibc) and
Windows x64 are kept.

The tars come from `docker pull node:24-alpine`, `docker pull nginx:1.29-alpine`, then
`docker save -o Valence-offline/images/node-24-alpine.tar node:24-alpine` (and the same for nginx), followed by a new
`SHA256SUMS.txt` (`sha256sum *.tar > SHA256SUMS.txt` in `images`).

## When something goes wrong

| What you see | Why, and what to do |
|---|---|
| Step 1 names a tar | The copy is damaged. Copy that file again. |
| Step 3: `pull access denied` / `failed to resolve source metadata` for node or nginx | The base image isn't loaded. Do step 2, or name your registry's images. |
| Step 3: `npm error code ENOTCACHED` | A package is missing from `Valence-offline\npm-offline\`. See step 3. |
| Step 3: `"/Valence-offline/npm-offline": not found` | The build didn't run from the repo root, or the repo is older than this kit. |
| Pod `ErrImagePull` / `ImagePullBackOff` | The cluster can't find the image. On kind, do step 5A. With a registry, check the name in step 6 and the pull secret. |
| Pod `CrashLoopBackOff`, log says `host not found in upstream "baseapi-service"` | BaseApi's service isn't in namespace `skp`. Check with `kubectl -n skp get svc baseapi-service`, or set `BASEAPI_URL` (step 6). |
| Pod `CrashLoopBackOff`, log says `invalid number of arguments in "proxy_pass"` | `BASEAPI_URL` is empty. Set it (step 6). |
| Pod crashes on OpenShift with permission errors | The image runs nginx as root, which OpenShift's default policy forbids. Allow the pod to run as root. Not tested. |
| The canvas says BaseApi could not be read | BaseApi isn't answering. See step 8. |
| Apply stays greyed: "the dry run, which is not available" | This BaseApi has no `/model/validate`. See step 8. |
| The chat: "The chat is not configured" | As shipped. See step 6. |
| A blank page | The browser has WebGL turned off, or it is too old. |
