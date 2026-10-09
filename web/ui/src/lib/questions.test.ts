import { expect, test } from 'vitest'

import type { Message, Question } from '@/api/types'
import { emptyDrafts, isAnswered, pendingQuestion, splitRecommended, toAnswers, toggleOption, typeOther } from './questions'

const single: Question = { question: 'Merge?', header: 'Merge', multiSelect: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }
const multi: Question = { ...single, question: 'Which?', multiSelect: true }
const q = (extra: Partial<Message> = {}): Message => ({ role: 'assistant', kind: 'question', text: '', id: 't', questions: [single], ...extra })

test('pendingQuestion is the last question, only while it has no outcome', () => {
  const asst: Message = { role: 'assistant', kind: 'assistant', text: 'hi' }
  expect(pendingQuestion([asst, q({ id: 'a' })])?.id).toBe('a')
  expect(pendingQuestion([q({ id: 'a' }), q({ id: 'b', answers: ['Yes'] })])).toBeNull()
  expect(pendingQuestion([q({ id: 'a', declined: true })])).toBeNull()
  expect(pendingQuestion([asst])).toBeNull()
  expect(pendingQuestion(null)).toBeNull()
})

test('single-select: one option or typed text, never both', () => {
  let d = emptyDrafts([single])[0]
  expect(isAnswered(d)).toBe(false)
  d = toggleOption(single, d, 1)
  expect(d).toEqual({ options: [1], text: '' })
  d = typeOther(single, d, 'later')
  expect(d).toEqual({ options: [], text: 'later' })
  d = toggleOption(single, d, 0)
  expect(d).toEqual({ options: [0], text: '' })
})

test('multi-select: options toggle and keep the typed text; text is one line', () => {
  let d = typeOther(multi, emptyDrafts([multi])[0], 'a\nb')
  d = toggleOption(multi, toggleOption(multi, d, 1), 0)
  expect(d).toEqual({ options: [0, 1], text: 'a b' })
  expect(toggleOption(multi, d, 0).options).toEqual([1])
  expect(toAnswers([d, { options: [1], text: '  ' }])).toEqual([{ options: [0, 1], text: 'a b' }, { options: [1] }])
})

test('splitRecommended strips the tag', () => {
  expect(splitRecommended('Mergeaj ti (Recommended)')).toEqual({ label: 'Mergeaj ti', recommended: true })
  expect(splitRecommended('No')).toEqual({ label: 'No', recommended: false })
})
