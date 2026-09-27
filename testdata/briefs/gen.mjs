// Regenerates the expected outputs in this folder from the web server's code (the reference
// implementation). Both test suites pin them: web/tests/briefs.test.mjs and the Rust
// `core::brief` tests. Run from the repo root: node testdata/briefs/gen.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { continuePrompt, parseBrief, serializeBrief } from '../../web/lib/brief-format.mjs';
import { createBriefs } from '../../web/lib/briefs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, f), 'utf8');
const write = (f, s) => fs.writeFileSync(path.join(here, f), s);

export const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
export const NOW = Date.parse('2026-01-02T05:00:00.000Z');

export function parsedShape(b) {
  return {
    meta: b.meta,
    preamble: b.preamble,
    summary: b.summary,
    resourcesText: b.resourcesText,
    planText: b.planText,
    extra: b.extra,
    resources: b.resources,
    plan: b.plan,
  };
}

/** The server's PUT on `before` with `edit`, at NOW, for a live session in ~/Code/project. */
export async function humanEdit(before, edit) {
  const files = new Map([[SID, before]]);
  const store = { read: async (id) => files.get(id) ?? null, write: async (id, t) => void files.set(id, t) };
  const svc = createBriefs({
    settings: { enabled: false },
    self: 'laptop',
    store,
    extractor: { refresh: async () => null },
    ask: async () => '',
    now: () => NOW,
  });
  await svc.put(SID, edit, { session_id: SID, cwd: '~/Code/project' });
  return files.get(SID);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sample = read('sample.md');
  const b = parseBrief(sample);
  write('sample.canonical.md', serializeBrief(b));
  write('sample.parsed.json', `${JSON.stringify(parsedShape(b), null, 2)}\n`);
  write('sample.continue.txt', continuePrompt(b));
  write('sample.edited.md', await humanEdit(sample, read('edit.md')));
  write('sample.edited-frontmatter.md', await humanEdit(sample, read('edit-frontmatter.md')));
  write('empty.edited.md', await humanEdit(null, read('edit.md')));
}
