// Claude Code's AskUserQuestion prompt: read it from the transcript, answer it by typing the
// keys a human would press in the terminal.
//
// The terminal UI (Claude Code 2.1): one tab per question, the cursor on option 1.
//   single-select  ↓ to an option + Enter picks it and moves on; option N+1 is "Type something."
//                  (typing there fills it in, Enter picks it)
//   multi-select   Enter toggles the option under the cursor; typing on "Type something" fills
//                  and checks it; the row after it ("Next" / "Submit") + Enter moves on
//   2+ questions   a "Review your answers" screen follows, "Submit answers" focused → Enter
// A lone single-select question submits on its pick (no review screen).

export const QUESTION_TOOL = 'AskUserQuestion';
export const MAX_ANSWER_TEXT = 2000;

const str = (v) => (typeof v === 'string' ? v : '');

/** The tool input's questions, normalized; null when it isn't a usable question list. */
export function normalizeQuestions(input) {
  const raw = input && Array.isArray(input.questions) ? input.questions : null;
  if (!raw?.length) return null;
  const out = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object' || !str(q.question).trim()) return null;
    const options = Array.isArray(q.options)
      ? q.options.filter((o) => o && str(o.label).trim()).map((o) => ({ label: str(o.label), description: str(o.description) }))
      : [];
    if (!options.length) return null;
    out.push({ question: str(q.question), header: str(q.header), multiSelect: q.multiSelect === true, options });
  }
  return out;
}

/** Plain-markdown rendering, for readers that don't know `kind: 'question'`. */
export function questionsText(questions) {
  return questions
    .map((q) => [`**${q.header ? `${q.header}: ` : ''}${q.question}**`, ...q.options.map((o) => `- ${o.label}`)].join('\n'))
    .join('\n\n');
}

/**
 * What became of the prompt, from its tool_result entry: `{ answers: (string|null)[] }` aligned
 * with `questions`, or `{ declined: true }` (Esc, "Chat about this", interrupted).
 */
export function questionOutcome(questions, entry, block) {
  const answers = entry?.toolUseResult?.answers;
  if (!block?.is_error && answers && typeof answers === 'object') {
    return { answers: questions.map((q) => (typeof answers[q.question] === 'string' ? answers[q.question] : null)) };
  }
  return { declined: true };
}

/**
 * The body of POST …/answer against the pending prompt's `questions`:
 *   { toolUseId, answers: [{ options: [index…], text? }] } — one entry per question, in order.
 * Single-select: exactly one option, or text. Multi-select: any options and/or text, at least one.
 */
export function validateAnswer(body, questions) {
  const b = body && typeof body === 'object' ? body : {};
  if (!Array.isArray(b.answers) || b.answers.length !== questions.length) {
    return { ok: false, error: `answers must be an array of ${questions.length}` };
  }
  const answers = [];
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const a = b.answers[i] && typeof b.answers[i] === 'object' ? b.answers[i] : {};
    const opts = Array.isArray(a.options) ? a.options : [];
    if (!opts.every((n) => Number.isInteger(n) && n >= 0 && n < q.options.length)) {
      return { ok: false, error: `answers[${i}].options: unknown option` };
    }
    const options = [...new Set(opts)].sort((x, y) => x - y);
    const text = typeof a.text === 'string' ? a.text.trim() : '';
    if (/[\r\n]/.test(text)) return { ok: false, error: `answers[${i}].text must be a single line` };
    if (text.length > MAX_ANSWER_TEXT) return { ok: false, error: `answers[${i}].text too long (max ${MAX_ANSWER_TEXT})` };
    if (q.multiSelect) {
      if (!options.length && !text) return { ok: false, error: `answers[${i}]: pick at least one option or type something` };
    } else if (options.length + (text ? 1 : 0) !== 1) {
      return { ok: false, error: `answers[${i}]: pick exactly one option or type something` };
    }
    answers.push({ options, text: text || null });
  }
  return { ok: true, answers };
}

/** The keystrokes answering `questions` with validated `answers`: `{ key }` or `{ text }` steps. */
export function answerSteps(questions, answers) {
  const steps = [];
  const down = (n) => {
    for (let i = 0; i < n; i += 1) steps.push({ key: 'Down' });
  };
  questions.forEach((q, i) => {
    const a = answers[i];
    const other = q.options.length; // the "Type something" row
    if (!q.multiSelect) {
      if (a.text) {
        down(other);
        steps.push({ text: a.text }, { key: 'Enter' });
      } else {
        down(a.options[0]);
        steps.push({ key: 'Enter' });
      }
      return;
    }
    let at = 0;
    for (const n of a.options) {
      down(n - at);
      steps.push({ key: 'Enter' });
      at = n;
    }
    if (a.text) {
      down(other - at);
      steps.push({ text: a.text });
      at = other;
    }
    down(other + 1 - at); // "Next" / "Submit"
    steps.push({ key: 'Enter' });
  });
  if (questions.length > 1) steps.push({ key: 'Enter' }); // review → "Submit answers"
  return steps;
}

const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Is the terminal showing this prompt, untouched? Its first question on screen (the TUI wraps
 * long lines, so compared whitespace-folded) with the cursor on option 1.
 */
export function screenShowsPrompt(screen, questions) {
  const flat = squash(screen);
  const q = squash(questions[0].question).slice(0, 60);
  return flat.includes(q) && /❯ 1\. /.test(flat) && /Enter to select/.test(flat);
}
