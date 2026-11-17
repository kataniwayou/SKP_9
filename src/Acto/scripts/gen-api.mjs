// Regenerates the BaseApi OpenAPI snapshot and the TypeScript types the studio compiles against.
//
// Why offline: BaseApi serves /swagger only in Development, and the cluster runs Production. The
// Swashbuckle CLI loads the built assembly, builds the host's service provider without starting
// it, and writes the same document Swagger would serve.
//
// Run from src/WorkflowStudio: npm run gen:api
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const studio = path.resolve(here, '..');
const repo = path.resolve(studio, '..', '..');
const project = path.join(repo, 'src', 'BaseApi.Service', 'BaseApi.Service.csproj');
const projectDir = path.dirname(project);
const dll = path.join(projectDir, 'bin', 'Debug', 'net8.0', 'BaseApi.Service.dll');
const doc = path.join(studio, 'openapi', 'baseapi.v1.json');
const types = path.join(studio, 'src', 'api', 'schema.d.ts');

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

run('dotnet', ['tool', 'restore'], repo);
run('dotnet', ['build', project, '-c', 'Debug', '--nologo'], repo);
// cwd must be the service's project folder: the host resolves its content root (appsettings.json)
// from the working directory, and from anywhere else it throws while building. The Swashbuckle CLI
// swallows that and falls back to a legacy Startup lookup, reporting "A type named 'Startup' could
// not be found", which hides the real cause.
run('dotnet', ['swagger', 'tofile', '--output', doc, dll, 'v1'], projectDir);
run('npx', ['openapi-typescript', doc, '-o', types], studio);
