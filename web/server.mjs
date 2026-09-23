#!/usr/bin/env node
// fleet-web — zero-dependency server for the fleet HTTP API + the bundled PWA.
// Config: the shared fleet config ($FLEET_CONFIG or ~/.config/fleet/config.json).
// See ARCHITECTURE.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, ensurePath } from './lib/config.mjs';
import { run } from './lib/run.mjs';
import { createFleetCli } from './lib/fleet-cli.mjs';
import { createFleet } from './lib/fleet.mjs';
import { createBackend } from './lib/backends.mjs';
import { createTranscriptReader } from './lib/transcript.mjs';
import { createSpawner } from './lib/spawn.mjs';
import { createApi } from './lib/api.mjs';
import { createHttpServer } from './lib/app.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'fleet-web';
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const log = (line) => process.stdout.write(`${line}\n`);
const logError = (err, context = '') =>
  process.stderr.write(`[error]${context ? ` ${context}` : ''} ${err?.stack ?? String(err)}\n`);

ensurePath(process.env);

let config;
try {
  config = loadConfig({ env: process.env, webRoot: ROOT, log: console });
} catch (err) {
  process.stderr.write(`[fleet-web] ${err.message}\n`);
  process.exit(2);
}

const cli = createFleetCli({ run, bin: config.fleetBin });
const fleet = createFleet({ cli, self: config.self, ttlMs: 2000 });
const handleApi = createApi({
  config,
  fleet,
  backend: createBackend({ run, tmux: config.tmux }),
  transcripts: createTranscriptReader(),
  spawner: createSpawner({ run, tmux: config.tmux, launcher: config.claude }),
  name: NAME,
  version: VERSION,
});

const server = createHttpServer({ handleApi, uiDir: config.uiDir, log, logError });

server.on('error', (err) => {
  logError(err, 'server');
  process.exit(1);
});

server.listen(config.port, config.bind, () => {
  log(`[fleet-web] self=${config.self} listening on http://${config.bind}:${config.port}`);
  log(`[fleet-web] config=${config.configFile ?? '(none, defaults)'} peers=${Object.keys(config.peers).join(',') || '(none)'}`);
  log(`[fleet-web] fleet=${config.fleetBin} tmux=${config.tmux} ui=${config.uiDir ?? '(none)'}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[fleet-web] ${signal} received, shutting down`);
  const timer = setTimeout(() => process.exit(0), 3000);
  timer.unref?.();
  server.close(() => {
    log('[fleet-web] closed');
    process.exit(0);
  });
  server.closeIdleConnections?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => logError(err, 'uncaughtException'));
process.on('unhandledRejection', (err) => logError(err, 'unhandledRejection'));
