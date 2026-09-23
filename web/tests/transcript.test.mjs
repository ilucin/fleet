import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUserText, encodeCwd, parseTranscript } from '../lib/transcript.mjs';

const line = (obj) => JSON.stringify(obj);
const user = (content, extra = {}) => line({ type: 'user', timestamp: '2026-09-18T18:01:52.017Z', message: { role: 'user', content }, ...extra });
const asst = (content, { id = 'msg_1', stop = 'end_turn' } = {}) =>
  line({ type: 'assistant', timestamp: '2026-09-18T18:01:57.000Z', message: { id, role: 'assistant', content, stop_reason: stop } });

test('encodeCwd mirrors the fleet CLI (slashes and dots become dashes)', () => {
  assert.equal(encodeCwd('/home/user/Code/project'), '-home-user-Code-project');
  assert.equal(encodeCwd('/tmp/a.b/c'), '-tmp-a-b-c');
});

test('parseTranscript keeps user prompts and assistant text, drops tools/thinking/meta', () => {
  const jsonl = [
    user('Hello there'),
    asst([{ type: 'thinking', thinking: 'hmm' }], { stop: 'tool_use' }),
    asst([{ type: 'text', text: 'Working on it.' }], { stop: 'tool_use' }),
    asst([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], { stop: 'tool_use' }),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'out' }]),
    asst([{ type: 'text', text: 'Done.' }], { id: 'msg_2' }),
    user('meta stuff', { isMeta: true }),
    line({ type: 'attachment', attachment: {} }),
    line({ type: 'system', subtype: 'hook' }),
    'not json',
  ].join('\n');
  const out = parseTranscript(jsonl);
  assert.deepEqual(
    out.map((m) => [m.role, m.text, m.final ?? null]),
    [
      ['user', 'Hello there', null],
      ['assistant', 'Working on it.', false],
      ['assistant', 'Done.', true],
    ],
  );
  assert.equal(typeof out[0].ts, 'number');
});

test('parseTranscript glues streamed blocks of one API message and skips sidechains', () => {
  const jsonl = [
    user('q'),
    asst([{ type: 'text', text: 'part one' }], { id: 'same', stop: 'tool_use' }),
    asst([{ type: 'text', text: 'part two' }], { id: 'same', stop: 'end_turn' }),
    line({ type: 'assistant', isSidechain: true, message: { id: 'side', role: 'assistant', content: [{ type: 'text', text: 'subagent' }] } }),
  ].join('\n');
  const out = parseTranscript(jsonl);
  assert.equal(out.length, 2);
  assert.equal(out[1].text, 'part one\n\npart two');
  assert.equal(out[1].final, true);
});

test('classifyUserText handles commands, task notifications, local-command noise and reminders', () => {
  assert.deepEqual(classifyUserText('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'), { kind: 'command', text: '/model opus' });
  assert.deepEqual(classifyUserText('<task-notification>\n<task-id>x</task-id>\n<summary>Agent "Build" finished</summary>\n</task-notification>'), { kind: 'system', text: 'Agent "Build" finished' });
  assert.equal(classifyUserText('<local-command-caveat>Caveat: ...</local-command-caveat>'), null);
  assert.equal(classifyUserText('<local-command-stdout>ok</local-command-stdout>'), null);
  assert.equal(classifyUserText('<system-reminder>ignore me</system-reminder>'), null);
  assert.deepEqual(classifyUserText('<system-reminder>ctx</system-reminder>\nReal question?'), { kind: 'user', text: 'Real question?' });
});
