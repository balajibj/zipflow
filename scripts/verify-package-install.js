#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? 60_000,
    env: {
      ...process.env,
      npm_config_registry: 'https://registry.npmjs.org/',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      npm_config_update_notifier: 'false',
      npm_config_fetch_retries: '0',
      npm_config_fetch_timeout: '10000',
      ...options.env,
    },
  });
}

export function npmInvocation(args, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const isFile = options.isFile ?? isRegularFile;
  const normalizedArgs = args.map((argument) => String(argument));
  if (platform !== 'win32') return { command: 'npm', args: normalizedArgs, env: {} };

  const lifecycleEntrypoint = validatedNpmLifecycleEntrypoint(env.npm_execpath, isFile);
  if (lifecycleEntrypoint) {
    return { command: execPath, args: [lifecycleEntrypoint, ...normalizedArgs], env: {} };
  }

  const commandProcessor = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
  if (path.win32.basename(commandProcessor).toLowerCase() !== 'cmd.exe') {
    throw new Error('Windows npm verification requires cmd.exe when npm_execpath is unavailable');
  }
  const argumentEnv = {};
  const argumentReferences = normalizedArgs.map((argument, index) => {
    if (/["\0\r\n]/.test(argument)) throw new Error('Windows npm verification argument contains an unsupported character');
    const key = `ZIPFLOW_NPM_ARG_${index}`;
    argumentEnv[key] = argument;
    return `"%${key}%"`;
  });
  const commandText = ['npm.cmd', ...argumentReferences].join(' ');
  return {
    command: commandProcessor,
    args: ['/d', '/s', '/v:off', '/c', commandText],
    env: argumentEnv,
  };
}

export function packageSmokeEndpoint(platform, directory, uniqueId) {
  if (platform === 'win32') {
    const safeId = String(uniqueId).replace(/[^A-Za-z0-9._-]/g, '-');
    return `\\\\.\\pipe\\zipflow-packed-client-${safeId}`;
  }
  return path.posix.join(directory, 'api.sock');
}

function validatedNpmLifecycleEntrypoint(candidate, isFile) {
  if (!candidate || !path.win32.isAbsolute(candidate)) return null;
  const normalized = path.win32.normalize(candidate).toLowerCase();
  if (!normalized.endsWith('\\npm\\bin\\npm-cli.js')) return null;
  return isFile(candidate) ? candidate : null;
}

function isRegularFile(target) {
  try { return statSync(target).isFile(); } catch { return false; }
}

function runNpm(args, options = {}) {
  const invocation = npmInvocation(args);
  return run(invocation.command, invocation.args, {
    ...options,
    env: {
      ...options.env,
      ...invocation.env,
    },
  });
}

function verifyPackageInstall() {
  const packageJson = readJson(path.join(root, 'package.json'));
  const shrinkwrap = readJson(path.join(root, 'npm-shrinkwrap.json'));
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'zipflow-package-'));
  try {
    const [pack] = JSON.parse(runNpm([
      'pack', '--json', '--ignore-scripts', '--dry-run=false', '--pack-destination', temporary,
    ]));
    const included = new Set(pack.files.map((file) => file.path));
    assert.ok(included.has('npm-shrinkwrap.json'), 'published package must include npm-shrinkwrap.json');
    for (const forbidden of ['package-lock.json', 'node_modules/', 'test/', '.zipflow/', '.env']) {
      assert.equal([...included].some((file) => file === forbidden || file.startsWith(forbidden)), false, `forbidden packed path: ${forbidden}`);
    }
    const tarball = path.join(temporary, pack.filename);
    const expectedDependencies = expectedDependencyVersions(shrinkwrap);
    const first = installAndReadVersions(tarball, path.join(temporary, 'consumer-one'), expectedDependencies, packageJson);
    const second = installAndReadVersions(tarball, path.join(temporary, 'consumer-two'), expectedDependencies, packageJson);
    assert.deepEqual(second, first, 'two clean package installations must resolve the same dependency versions');
    for (const [name, expected] of Object.entries(packageJson.dependencies)) {
      assert.equal(first[name], expected, `${name} must resolve to the pinned runtime version`);
      assert.equal(shrinkwrap.packages[`node_modules/${name}`]?.version, expected, `${name} must match npm-shrinkwrap.json`);
    }
    console.log(`Verified zipflow ${packageJson.version}: ${pack.entryCount} files; deterministic runtime dependencies installed twice.`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function installAndReadVersions(tarball, directory, expectedDependencies, packageJson) {
  mkdirSync(directory);
  writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify({ private: true }, null, 2)}\n`);
  runNpm([
    'install', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund',
    '--fetch-retries=0', '--fetch-timeout=10000', tarball,
  ], { cwd: directory });
  const installedRoot = path.join(directory, 'node_modules', 'zipflow');
  const installedPackage = readJson(path.join(installedRoot, 'package.json'));
  assert.equal(installedPackage.version, packageJson.version);
  const versions = {};
  for (const [name, expectedVersion] of Object.entries(expectedDependencies)) {
    const candidates = [
      path.join(installedRoot, 'node_modules', name, 'package.json'),
      path.join(directory, 'node_modules', name, 'package.json'),
    ];
    const dependencyPath = candidates.find((candidate) => {
      try { readFileSync(candidate); return true; } catch { return false; }
    });
    assert.ok(dependencyPath, `installed dependency is missing: ${name}`);
    versions[name] = readJson(dependencyPath).version;
    assert.equal(versions[name], expectedVersion, `${name} must match npm-shrinkwrap.json`);
  }
  const versionOutput = run(process.execPath, [path.join(installedRoot, 'bin', 'zipflow.js'), '--version'], { cwd: directory }).trim();
  assert.equal(versionOutput, packageJson.version);
  verifyInstalledClient(directory);
  return versions;
}

function verifyInstalledClient(directory) {
  const smokePath = path.join(directory, 'client-smoke.mjs');
  const socketPath = packageSmokeEndpoint(process.platform, directory, `${process.pid}-${randomUUID()}`);
  writeFileSync(smokePath, String.raw`
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
const before = {
  sigint: process.listenerCount('SIGINT'),
  sigterm: process.listenerCount('SIGTERM'),
};
const { createZipflowClient } = await import('zipflow/client');
const { getConformanceFixture } = await import('zipflow/protocol');
const socketPath = ${JSON.stringify(socketPath)};
const token = 'packed-client-authentication-token';
const server = http.createServer((request, response) => {
  assert.equal(request.url, '/v1/hello');
  if (request.headers.authorization !== 'Bearer ' + token) {
    response.writeHead(401, { 'content-type': 'application/problem+json' });
    response.end();
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(getConformanceFixture('hello')));
});

try {
  server.listen(socketPath);
  await once(server, 'listening');
  const client = createZipflowClient({ socketPath, token });
  const hello = await client.hello();
  assert.equal(hello.apiVersion, '1.0');
  assert.equal(hello.server.name, 'zipflow');
  assert.deepEqual({
    sigint: process.listenerCount('SIGINT'),
    sigterm: process.listenerCount('SIGTERM'),
  }, before);
} finally {
  const closed = once(server, 'close');
  server.close();
  await closed;
}
`);
  run(process.execPath, [smokePath], { cwd: directory });
}

function expectedDependencyVersions(lock) {
  const versions = {};
  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    if (!packagePath.startsWith('node_modules/') || !entry?.version) continue;
    const name = packageNameFromLockPath(packagePath);
    assert.equal(versions[name] === undefined || versions[name] === entry.version, true, `duplicate locked versions are not supported by this verification: ${name}`);
    versions[name] = entry.version;
  }
  return versions;
}

function packageNameFromLockPath(packagePath) {
  const parts = packagePath.split('node_modules/').at(-1).split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

function readJson(target) {
  return JSON.parse(readFileSync(target, 'utf8'));
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entrypoint === fileURLToPath(import.meta.url)) verifyPackageInstall();
