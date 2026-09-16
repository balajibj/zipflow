import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmInvocation, packageSmokeEndpoint } from '../scripts/verify-package-install.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const readme = await readFile(path.join(root, 'README.md'), 'utf8');

test('npm release metadata declares a public executable package and a verification gate', async () => {
  assert.equal(packageJson.name, 'zipflow');
  assert.equal(packageJson.publishConfig?.access, 'public');
  assert.equal(packageJson.publishConfig?.registry, 'https://registry.npmjs.org/');
  assert.equal(packageJson.bin?.zipflow, './bin/zipflow.js');
  assert.match(packageJson.engines?.node ?? '', />=20/);
  assert.deepEqual(packageJson.os, ['darwin', 'linux', 'win32']);
  assert.ok(packageJson.keywords.includes('terminal'));
  assert.ok(packageJson.keywords.includes('rollback'));
  assert.equal(packageJson.scripts?.prepublishOnly, 'npm run verify && npm run test:package');
  assert.match(packageJson.scripts?.['release:check'] ?? '', /npm run verify/);
  assert.match(packageJson.scripts?.['release:check'] ?? '', /npm run test:package/);
  assert.match(packageJson.scripts?.['release:check'] ?? '', /npm pack --dry-run/);
  assert.equal(packageJson.scripts?.['test:package'], 'node ./scripts/verify-package-install.js');
  assert.ok(packageJson.files.includes('docs'));
  assert.ok(packageJson.files.includes('npm-shrinkwrap.json'));

  const executable = await stat(path.join(root, 'bin/zipflow.js'));
  assert.notEqual(executable.mode & 0o111, 0);
});

test('package README stays concise and sends detailed guidance to docs', async () => {
  assert.ok(readme.split(/\r?\n/).length <= 140);
  assert.match(readme, /npm install --global zipflow/);
  assert.match(readme, /docs\/README\.md/);
  assert.match(readme, /Automatic updates/);
  assert.doesNotMatch(readme, /^## Safety model$/m);
  assert.doesNotMatch(readme, /^## Decision modes and autopilot$/m);
  assert.doesNotMatch(readme, /^## Data and storage$/m);

  for (const file of [
    'docs/README.md',
    'docs/getting-started.md',
    'docs/safety.md',
    'docs/local-llm.md',
    'docs/settings-and-storage.md',
    'docs/development.md',
    'docs/updates.md',
  ]) await access(path.join(root, file));
});

test('package verifier selects bounded npm launchers without changing arguments', () => {
  const argumentsToPreserve = [
    'install', '--ignore-scripts', 'C:\\Temp\\zip flow & proof\\zipflow-1.9.0.tgz',
  ];
  assert.deepEqual(npmInvocation(argumentsToPreserve, {
    platform: 'linux', env: {}, execPath: '/usr/bin/node', isFile: () => false,
  }), {
    command: 'npm', args: argumentsToPreserve, env: {},
  });

  const npmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  assert.deepEqual(npmInvocation(argumentsToPreserve, {
    platform: 'win32', env: { npm_execpath: npmCli }, execPath: 'C:\\Program Files\\nodejs\\node.exe',
    isFile: (candidate) => candidate === npmCli,
  }), {
    command: 'C:\\Program Files\\nodejs\\node.exe', args: [npmCli, ...argumentsToPreserve], env: {},
  });

  const fallback = npmInvocation(argumentsToPreserve, {
    platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    execPath: 'C:\\Program Files\\nodejs\\node.exe', isFile: () => false,
  });
  assert.equal(fallback.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(fallback.args.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
  assert.equal(fallback.args[4], 'npm.cmd "%ZIPFLOW_NPM_ARG_0%" "%ZIPFLOW_NPM_ARG_1%" "%ZIPFLOW_NPM_ARG_2%"');
  assert.deepEqual(fallback.env, {
    ZIPFLOW_NPM_ARG_0: argumentsToPreserve[0],
    ZIPFLOW_NPM_ARG_1: argumentsToPreserve[1],
    ZIPFLOW_NPM_ARG_2: argumentsToPreserve[2],
  });
  assert.doesNotMatch(fallback.args[4], /zip flow|ignore-scripts/);
});

test('package verifier selects a unique Windows named pipe and preserves Unix sockets', () => {
  assert.equal(
    packageSmokeEndpoint('win32', 'C:\\ignored', '1234-proof'),
    '\\\\.\\pipe\\zipflow-packed-client-1234-proof',
  );
  assert.notEqual(
    packageSmokeEndpoint('win32', 'C:\\ignored', '1234-proof'),
    packageSmokeEndpoint('win32', 'C:\\ignored', '1234-other'),
  );
  assert.equal(packageSmokeEndpoint('linux', '/tmp/zipflow-packed-client', 'ignored'), '/tmp/zipflow-packed-client/api.sock');
});
