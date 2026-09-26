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
import { createKiller } from './lib/kill.mjs';
import { createAutoNamer } from './lib/autoname.mjs';
import { createGrouper } from './lib/grouping.mjs';
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
const backend = createBackend({ run, tmux: config.tmux });
const autoNamer = createAutoNamer({
  cli,
  run,
  tmux: config.tmux,
  listSessions: () => fleet.localSessions({ force: true }),
  intervalMs: config.autoName.intervalMinutes * 60 * 1000,
  log,
});
// Only the grouping host runs the pass; the fleet accessors are bound once the API exists.
let fleetAccess = null;
const grouper = config.grouping.enabled
  ? createGrouper({
      cli,
      getFleet: () => fleetAccess.buildFleet(),
      peekFleet: () => fleetAccess.peekFleet(),
      self: config.self,
      intervalMs: config.grouping.intervalMinutes * 60 * 1000,
      log,
    })
  : null;
const handleApi = createApi({
  config,
  fleet,
  backend,
  transcripts: createTranscriptReader(),
  spawner: createSpawner({ run, tmux: config.tmux, launcher: config.claude }),
  killer: createKiller({ run, tmux: config.tmux, closeIterm: (s) => backend.closeIterm(s) }),
  autoNamer,
  grouper,
  name: NAME,
  version: VERSION,
  logError,
});

fleetAccess = handleApi;

const server = createHttpServer({ handleApi, uiDir: config.uiDir, log, logError });

server.on('error', (err) => {
  logError(err, 'server');
  process.exit(1);
});

server.listen(config.port, config.bind, () => {
  log(`[fleet-web] self=${config.self} listening on http://${config.bind}:${config.port}`);
  log(`[fleet-web] config=${config.configFile ?? '(none, defaults)'} peers=${Object.keys(config.peers).join(',') || '(none)'}`);
  log(`[fleet-web] fleet=${config.fleetBin} tmux=${config.tmux} ui=${config.uiDir ?? '(none)'}`);
  if (config.autoName.enabled) {
    autoNamer.start();
    log(`[fleet-web] autoname every ${config.autoName.intervalMinutes}m (fleet name --all --apply)`);
  } else {
    log('[fleet-web] autoname off (web.autoName.enabled = false)');
  }
  if (grouper) {
    grouper.start();
    log(`[fleet-web] grouping every ${config.grouping.intervalMinutes}m (fleet group, all hosts)`);
  } else if (config.grouping.host && config.grouping.host !== config.self) {
    log(`[fleet-web] grouping: served by ${config.grouping.host}`);
  } else {
    log('[fleet-web] grouping off (web.grouping.enabled = false)');
  }
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[fleet-web] ${signal} received, shutting down`);
  autoNamer.stop();
  grouper?.stop();
  handleApi.stop();
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
