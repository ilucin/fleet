import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answerSteps, normalizeQuestions, questionOutcome, screenShowsPrompt, validateAnswer } from '../lib/questions.mjs';

const qs = normalizeQuestions({
  questions: [
    { question: 'Which pets do you like?', header: 'Pets', multiSelect: true, options: [{ label: 'Dog' }, { label: 'Cat' }, { label: 'Fish' }] },
    { question: 'Which city?', header: 'City', multiSelect: false, options: [{ label: 'Paris', description: 'FR' }, { label: 'Rome' }, { label: 'Oslo' }] },
  ],
});
const keys = (steps) => steps.map((s) => s.key ?? `"${s.text}"`).join(' ');

test('normalizeQuestions keeps question, header, multiSelect and labelled options', () => {
  assert.equal(qs.length, 2);
  assert.deepEqual(qs[1].options[0], { label: 'Paris', description: 'FR' });
  assert.equal(qs[0].multiSelect, true);
  assert.equal(normalizeQuestions({}), null);
  assert.equal(normalizeQuestions({ questions: [{ question: 'Q', options: [] }] }), null);
});

test('answerSteps: single-select picks by arrows, a lone question needs no review', () => {
  const one = [qs[1]];
  assert.equal(keys(answerSteps(one, [{ options: [0], text: null }])), 'Enter');
  assert.equal(keys(answerSteps(one, [{ options: [2], text: null }])), 'Down Down Enter');
  assert.equal(keys(answerSteps(one, [{ options: [], text: 'Zagreb' }])), 'Down Down Down "Zagreb" Enter');
});

test('answerSteps: multi-select toggles, types, moves to Next; 2+ questions end on the review', () => {
  const steps = answerSteps(qs, [
    { options: [0, 2], text: 'hamster' },
    { options: [], text: 'Zagreb, obviously' },
  ]);
  assert.equal(
    keys(steps),
    ['Enter Down Down Enter Down "hamster" Down Enter', 'Down Down Down "Zagreb, obviously" Enter', 'Enter'].join(' '),
  );
  assert.equal(keys(answerSteps(qs, [{ options: [1], text: null }, { options: [1], text: null }])), 'Down Enter Down Down Down Enter Down Enter Enter');
});

test('validateAnswer enforces one pick for single-select, at least one for multi', () => {
  assert.equal(validateAnswer({ answers: [{ options: [0] }] }, qs).ok, false, 'one entry per question');
  assert.equal(validateAnswer({ answers: [{ options: [] }, { options: [0] }] }, qs).ok, false, 'multi needs something');
  assert.equal(validateAnswer({ answers: [{ options: [0] }, { options: [0, 1] }] }, qs).ok, false, 'single takes one');
  assert.equal(validateAnswer({ answers: [{ options: [0] }, { options: [0], text: 'x' }] }, qs).ok, false, 'single: option or text');
  assert.equal(validateAnswer({ answers: [{ options: [3] }, { options: [0] }] }, qs).ok, false, 'unknown option');
  assert.equal(validateAnswer({ answers: [{ text: 'a\nb' }, { options: [0] }] }, qs).ok, false, 'one line');
  assert.deepEqual(validateAnswer({ answers: [{ options: [2, 0, 2] }, { text: ' Zagreb ' }] }, qs), {
    ok: true,
    answers: [
      { options: [0, 2], text: null },
      { options: [], text: 'Zagreb' },
    ],
  });
});

test('questionOutcome: answers in question order, or declined', () => {
  const entry = { toolUseResult: { answers: { 'Which city?': 'Rome', 'Which pets do you like?': 'Dog, Fish' } } };
  assert.deepEqual(questionOutcome(qs, entry, { type: 'tool_result' }), { answers: ['Dog, Fish', 'Rome'] });
  assert.deepEqual(questionOutcome(qs, { toolUseResult: 'User rejected tool use' }, { is_error: true }), { declined: true });
});

test('screenShowsPrompt wants the first question, the cursor on option 1 and the prompt footer', () => {
  const screen = '←  ☐ Pets  ☐ City  ✔ Submit  →\nWhich pets do you\nlike?\n❯ 1. [ ] Dog\n  2. [ ] Cat\nEnter to select · Tab/Arrow keys to navigate';
  assert.equal(screenShowsPrompt(screen, qs), true);
  assert.equal(screenShowsPrompt(screen.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.'), qs), false);
  assert.equal(screenShowsPrompt('Which city?\n❯ 1. Paris\nEnter to select', qs), false);
  assert.equal(screenShowsPrompt('❯ ', qs), false);
});
