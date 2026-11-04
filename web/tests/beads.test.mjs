// Beads: bead ids found in a session's `bd` commands (lib/brief-extract.mjs), reduced to their
// top-level parents by a fake `bd` (lib/beads.mjs), the config keys and the HTTP routes (incl. a
// peer proxy). The real `bd` is never run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beadIdsInCommand, createBriefExtractor } from '../lib/brief-extract.mjs';
import { createBeads, parentOf } from '../lib/beads.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { createApi } from '../lib/api.mjs';
import { createHttpServer } from '../lib/app.mjs';
import { createFleet } from '../lib/fleet.mjs';
import { createFleetCli } from '../lib/fleet-cli.mjs';

const SID = 'bbbbbbbb-1111-2222-3333-444444444444';

function tmpdir(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-beads-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const line = (o) => `${JSON.stringify(o)}\n`;
const toolUse = (id, name, input) => line({ type: 'assistant', message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, text) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

// A small issue graph: an epic with two children (one with a grandchild), a loose issue, and an
// issue whose parent is only in its `parent` field.
const ISSUES = {
  'bd-ep1': { id: 'bd-ep1', title: 'Epic', status: 'open', issue_type: 'epic', priority: 1, labels: ['x'] },
  'bd-ep1.1': { id: 'bd-ep1.1', title: 'One', status: 'closed', parent: 'bd-ep1', dependencies: [] },
  'bd-ep1.2': {
    id: 'bd-ep1.2',
    title: 'Two',
    status: 'in_progress',
    parent: 'bd-ep1',
    dependencies: [
      { issue_id: 'bd-ep1.2', depends_on_id: 'bd-ep1.1', type: 'blocks' },
      { issue_id: 'bd-ep1.2', depends_on_id: 'bd-lo5', type: 'related' },
    ],
  },
  'bd-ep1.2.1': { id: 'bd-ep1.2.1', title: 'Deep', status: 'open', parent: 'bd-ep1.2' },
  'bd-lo5': { id: 'bd-lo5', title: 'Loose', status: 'open', comment_count: 1 },
  'bd-kid': { id: 'bd-kid', title: 'Kid', status: 'open', dependencies: [{ issue_id: 'bd-kid', depends_on_id: 'bd-lo5', type: 'parent-child' }] },
};

function fakeBd(calls) {
  return async (args, opts) => {
    calls.push({ args, opts });
    const [cmd, ...rest] = args;
    if (cmd === 'show') {
      const ids = rest.filter((a) => !a.startsWith('--'));
      const found = ids.filter((id) => ISSUES[id]).map((id) => ISSUES[id]);
      if (found.length < ids.length) {
        const err = new Error('Issue not found');
        err.stdout = JSON.stringify(found);
        throw err;
      }
      return { stdout: JSON.stringify(found) };
    }
    if (cmd === 'list') {
      const parent = rest[rest.indexOf('--parent') + 1];
      return { stdout: JSON.stringify(Object.values(ISSUES).filter((i) => parentOf(i) === parent)) };
    }
    if (cmd === 'comments') return { stdout: JSON.stringify([{ author: 'me', text: 'hello', created_at: '2026-01-01T00:00:00Z' }]) };
    throw new Error(`unexpected bd ${args.join(' ')}`);
  };
}

function transcript(t) {
  const dir = tmpdir(t);
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(
    file,
    [
      toolUse('t1', 'Bash', { command: 'bd list --json | head' }),
      toolResult('t1', '[{"id":"bd-zzz"}]'),
      toolUse('t2', 'Bash', { command: 'bd create "Fix not-propagated" --parent bd-ep1 -l agentic-std' }),
      toolResult('t2', '✓ Created issue: bd-ep1.2.1'),
      toolUse('t3', 'Bash', { command: 'bd dep add bd-kid bd-lo5 && ls bd-nope' }),
      toolUse('t4', 'Bash', { command: "cat > b.md <<'EOF'\nsee bd-heredoc\nEOF\nbd q \"x\"" }),
      toolResult('t4', 'bd-ep1.1'),
      toolUse('t5', 'Bash', { command: 'git log bd-notbd' }),
    ].join(''),
  );
  return { dir, file };
}

test('beadIdsInCommand: ids in bd commands, not in quotes, heredocs or other commands', () => {
  assert.deepEqual(beadIdsInCommand('bd dep add bd-5kc.9 bd-5kc.8 && bd link bd-5kc.9 bd-5kc.3 --type related'), ['bd-5kc.9', 'bd-5kc.8', 'bd-5kc.3']);
  assert.deepEqual(beadIdsInCommand('bd create "not-propagated" --parent bd-5kc --no-parent'), ['bd-5kc']);
  assert.deepEqual(beadIdsInCommand("cat <<'EOF'\nbd-x1y\nEOF\nbd q t"), []);
  assert.deepEqual(beadIdsInCommand('ls bd-5kc'), []);
  assert.deepEqual(beadIdsInCommand('BEADS_DIR=/x bd show work-a1b2.1'), ['work-a1b2.1']);
});

test('extract → beads: the session’s top-level parents with child progress', async (t) => {
  const { file } = transcript(t);
  const ex = createBriefExtractor({ locate: async () => file });
  const ext = await ex.refresh({ session_id: SID, cwd: '/w' });
  // Newest first; a whole compound command counts (bd checks what exists), quotes and heredocs do not.
  assert.deepEqual(ext.beads, ['bd-ep1.1', 'bd-nope', 'bd-lo5', 'bd-kid', 'bd-ep1.2.1', 'agentic-std', 'bd-ep1']);

  const calls = [];
  let now = 0;
  const beads = createBeads({ bd: fakeBd(calls), extractor: ex, settings: { dir: '/db' }, env: { PATH: '/bin' }, now: () => now });
  const r = await beads.list({ session_id: SID, cwd: '/w' });
  assert.deepEqual(
    r.beads.map((b) => [b.id, b.children]),
    [
      ['bd-ep1', { total: 2, closed: 1, inProgress: 1 }],
      ['bd-lo5', { total: 1, closed: 0, inProgress: 0 }],
    ],
    'children and a parent named only by a dependency roll up; unknown ids drop',
  );
  assert.equal(calls[0].opts.cwd, '/w');
  assert.equal(calls[0].opts.env.BEADS_DIR, '/db');
  const n = calls.length;
  await beads.list({ session_id: SID, cwd: '/w' });
  assert.equal(calls.length, n, 'cached');
  now += 60_000;
  await beads.list({ session_id: SID, cwd: '/w' });
  assert.ok(calls.length > n, 'refreshed after the ttl');

  const d = await beads.bead({ session_id: SID, cwd: '/w' }, 'bd-ep1.2');
  assert.equal(d.parent.id, 'bd-ep1');
  assert.deepEqual(d.issue.blockedBy, ['bd-ep1.1']);
  assert.deepEqual(d.issue.related, ['bd-lo5']);
  assert.deepEqual(d.children.map((c) => c.id), ['bd-ep1.2.1']);
  assert.equal((await beads.bead({ session_id: SID }, 'bd-lo5')).comments[0].text, 'hello');
  assert.equal(await beads.bead({ session_id: SID }, 'bd-missing'), null);

  const off = createBeads({ bd: null, extractor: ex });
  assert.deepEqual(await off.list({ session_id: SID }), { enabled: false, beads: [] });
});

test('config: web.beads', () => {
  const home = '/home/tester';
  assert.deepEqual(normalizeConfig({}, { env: {}, home }).beads, { enabled: true, dir: null });
  assert.equal(normalizeConfig({}, { env: { BEADS_DIR: '/env/db' }, home }).beads.dir, '/env/db');
  assert.deepEqual(normalizeConfig({ web: { beads: { dir: '~/db', enabled: false } } }, { env: { BEADS_DIR: '/env/db' }, home }).beads, { enabled: false, dir: '/home/tester/db' });
  assert.throws(() => normalizeConfig({ web: { beads: { dir: 'rel' } } }, { env: {}, home }), /beads\.dir/);
  assert.throws(() => normalizeConfig({ web: { beads: { enabled: 'y' } } }, { env: {}, home }), /beads\.enabled/);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

test('api: list and viewer, locally and through a peer', async (t) => {
  const { file } = transcript(t);
  const sessions = [{ session_id: SID, cwd: '/w', status: 'idle', backend: 'tmux', handle: '%1', updated_at: 1 }];
  const beads = createBeads({ bd: fakeBd([]), extractor: createBriefExtractor({ locate: async () => file }) });
  const hosts = {};
  for (const name of ['laptop', 'workstation']) {
    let handle = null;
    const server = createHttpServer({ handleApi: (req, url) => handle(req, url) });
    hosts[name] = { url: await listen(server), setHandle: (h) => (handle = h) };
    t.after(() => server.close());
  }
  for (const name of ['laptop', 'workstation']) {
    const config = normalizeConfig({ self: name, hosts: { laptop: { ssh: null, web: hosts.laptop.url }, workstation: { ssh: 'workstation', web: hosts.workstation.url } } }, { env: {}, home: '/home/tester' });
    const cli = createFleetCli({ run: async () => ({ stdout: JSON.stringify(name === 'workstation' ? sessions : []), stderr: '' }) });
    const api = createApi({ config, fleet: createFleet({ cli, self: name, ttlMs: 0 }), backend: {}, transcripts: {}, spawner: {}, beads: name === 'workstation' ? beads : null, warmFleet: false });
    hosts[name].setHandle(api);
  }
  const base = `${hosts.laptop.url}/api/hosts/workstation/sessions/${SID.slice(0, 8)}/beads`;
  let body = await (await fetch(base)).json();
  assert.equal(body.host, 'workstation');
  assert.equal(body.enabled, true);
  assert.deepEqual(body.beads.map((b) => b.id), ['bd-ep1', 'bd-lo5']);
  body = await (await fetch(`${base}/bd-ep1`)).json();
  assert.equal(body.issue.title, 'Epic');
  assert.equal(body.children.length, 2);
  assert.equal((await fetch(`${base}/bd-missing`)).status, 404);
  assert.equal((await fetch(`${base}/--json`)).status, 400);
  assert.equal((await fetch(base, { method: 'POST', body: '{}' })).status, 405);
  body = await (await fetch(`${hosts.laptop.url}/api/hosts/laptop/sessions/x/beads`)).json();
  assert.deepEqual(body, { host: 'laptop', enabled: false, beads: [] }, 'no bd on the laptop server');
});
