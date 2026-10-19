// The offline npm feeds (2026-10-12, one per web app since 2026-10-19), the npm counterpart of the repo's nugets/: every
// package an app's package-lock.json installs, as the registry's own .tgz, in its kit's npm-offline/. The app's Docker
// build installs from that folder only, never from the network, so a package missing there fails the build by name.
//
//   node tools/vendor-npm.mjs <app>            download what is missing, remove what the lock file no longer names
//   node tools/vendor-npm.mjs <app> --check    only check: every package present and matching the lock file's checksum
//   node tools/vendor-npm.mjs <app> --install  offline: check, then npm ci in the app's folder from npm-offline/ alone
//                                              (a temporary cache, never the network), for a compile outside Docker
//
// <app> is studio (src/WorkflowStudio, Studio-offline/npm-offline) or valence (src/Valence, Valence-offline/npm-offline).
// Run it after every change to the app's package-lock.json, and commit npm-offline/ with it. Platform builds are kept
// only for the platforms below (the Docker build's Linux, both libcs, and Windows for a local npm ci); a machine on
// another platform installs its own from npm.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPS = {
  studio: { source: 'src/WorkflowStudio', kit: 'Studio-offline' },
  valence: { source: 'src/Valence', kit: 'Valence-offline' },
};
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = APPS[process.argv[2]];
if (!app) {
  console.error(`usage: node tools/vendor-npm.mjs <${Object.keys(APPS).join('|')}> [--check|--install]`);
  process.exit(2);
}
const root = join(repo, app.source);
const feed = join(repo, app.kit, 'npm-offline');
const install = process.argv.includes('--install');
const check = install || process.argv.includes('--check');
const PLATFORMS = [['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64']];

/** The file a package is kept as: its name with the scope's slash made a plus, and its version. */
export const fileOf = (name, version) => `${name.replace('/', '+')}-${version}.tgz`;

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const wanted = new Map();
for (const [path, p] of Object.entries(lock.packages)) {
  if (!path || p.link || !p.resolved) continue;
  const kept = !p.os && !p.cpu || PLATFORMS.some(([os, cpu]) => (!p.os || p.os.includes(os)) && (!p.cpu || p.cpu.includes(cpu)));
  if (!kept) continue;
  const name = p.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  wanted.set(fileOf(name, p.version), { url: p.resolved, integrity: p.integrity });
}

const matches = (bytes, integrity) => {
  const [algo, digest] = integrity.split('-', 2);
  return createHash(algo).update(bytes).digest('base64') === digest;
};

if (!existsSync(feed)) mkdirSync(feed, { recursive: true });
const problems = [];
let fetched = 0;
for (const [file, { url, integrity }] of wanted) {
  const at = join(feed, file);
  if (existsSync(at) && matches(readFileSync(at), integrity)) continue;
  if (check) { problems.push(existsSync(at) ? `${file}: checksum does not match the lock file` : `${file}: missing`); continue; }
  const r = await fetch(url);
  if (!r.ok) { problems.push(`${file}: ${url} answered HTTP ${r.status}`); continue; }
  const bytes = Buffer.from(await r.arrayBuffer());
  if (!matches(bytes, integrity)) { problems.push(`${file}: the download does not match the lock file's checksum`); continue; }
  writeFileSync(at, bytes);
  fetched++;
}
const stale = readdirSync(feed).filter((f) => f.endsWith('.tgz') && !wanted.has(f));
if (check) stale.forEach((f) => problems.push(`${f}: not in the lock file`));
else stale.forEach((f) => unlinkSync(join(feed, f)));

const label = `${app.kit}/npm-offline`;
if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${label}: ${problems.length} problem(s)${check ? `; run node tools/vendor-npm.mjs ${process.argv[2]}` : ''}`);
  process.exit(1);
}
console.log(`${label}: ${wanted.size} packages${check ? ', all present and matching' : `, ${fetched} downloaded, ${stale.length} removed`}`);

if (install) {
  // npm reads a bare "dir/x.tgz" as a GitHub repository: each file is named by a path starting with "./" or "../";
  // npm runs through the shell on Windows (npm.cmd), whose line is short, so the files go in batches
  const npm = (args) => {
    const r = spawnSync('npm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  };
  const cache = mkdtempSync(join(tmpdir(), 'skp-npm-offline-'));
  try {
    const from = relative(root, feed).replaceAll('\\', '/');
    const files = [...wanted.keys()].map((f) => `${from}/${f}`);
    for (let i = 0; i < files.length; i += 40) npm(['cache', 'add', ...files.slice(i, i + 40), '--cache', cache, '--loglevel=error']);
    npm(['ci', '--offline', '--cache', cache, '--no-audit', '--no-fund']);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}
