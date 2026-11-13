import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BRIEF_SOURCE, PRUNE_AFTER_MS, createTitleStore, sanitizeTitle, slugify } from '../lib/titles.mjs';

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-titles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, '.claude', 'fleet-names.json');
}

test('titles: model answers are reduced to a slug, prose is rejected', () => {
  assert.equal(sanitizeTitle('fleet-brief-prompt'), 'fleet-brief-prompt');
  assert.equal(sanitizeTitle('```\n`Fleet-Brief-Prompt`\n```'), 'fleet-brief-prompt');
  assert.equal(sanitizeTitle('Here it is: "api-upload-retries"'), 'api-upload-retries');
  assert.equal(sanitizeTitle('I cannot name this session'), null);
  assert.equal(sanitizeTitle(''), null);
  assert.equal(sanitizeTitle('x'.repeat(61)), null);
  assert.equal(slugify('deprecated-session-tokens-cleanup'), 'deprecated-session-tokens');
});

test('titles: write keeps other entries, stamps source brief and prunes old ones', (t) => {
  const file = tmpFile(t);
  const now = Date.parse('2026-06-01T00:00:00Z');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      keep: { name: 'other-title', source: 'llm', generated_at: now - 1000, input_hash: 'h' },
      old: { name: 'ancient', source: 'llm', generated_at: now - PRUNE_AFTER_MS - 1, input_hash: 'h' },
    }),
  );
  const store = createTitleStore({ file, now: () => now });
  assert.equal(store.read('keep'), 'other-title');
  assert.equal(store.read('sid'), null);
  store.write('sid', 'fleet-title-refresh');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(disk.sid, { name: 'fleet-title-refresh', source: BRIEF_SOURCE, generated_at: now, input_hash: '' });
  assert.equal(disk.keep.name, 'other-title');
  assert.equal(disk.old, undefined);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['fleet-names.json'], 'no temp file left');
});

test('titles: a missing or corrupt file reads as empty and is replaced on write', (t) => {
  const file = tmpFile(t);
  const store = createTitleStore({ file, now: () => 1e12 });
  assert.equal(store.read('sid'), null);
  store.write('sid', 'a-title');
  fs.writeFileSync(file, '{not json');
  assert.equal(store.read('sid'), null);
  store.write('sid', 'b-title');
  assert.equal(store.read('sid'), 'b-title');
});
