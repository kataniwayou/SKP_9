// Runs the e2e suite in a visible Chromium window, slowed down so a person can follow it:
//   node scripts/e2e-watch.mjs [any playwright test arguments]
// ACTO_SLOWMO (ms between Playwright actions) defaults to 350 here; set it to change the pace.
import { spawn } from 'node:child_process';

const env = { ...process.env, ACTO_SLOWMO: process.env.ACTO_SLOWMO ?? '350' };
const child = spawn('npx', ['playwright', 'test', '--headed', ...process.argv.slice(2)], { stdio: 'inherit', env, shell: process.platform === 'win32' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
