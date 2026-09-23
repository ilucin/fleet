import { expect, test } from 'vitest'

import type { Message } from '@/api/types'

import { CHAT_FONT_SIZES, nearBottom, nextChatLimit, parseMode, parseSize, sameGroup, stepSize, visibleMessages } from './chat'

const m = (over: Partial<Message>): Message => ({ role: 'assistant', kind: 'assistant', text: 'x', ts: 1_000_000, ...over })

test('parseMode / parseSize', () => {
  expect(parseMode('term')).toBe('term')
  expect(parseMode('garbage')).toBe('chat')
  expect(parseSize(CHAT_FONT_SIZES)('17')).toBe(17)
  expect(parseSize(CHAT_FONT_SIZES)('16')).toBeUndefined()
})

test('stepSize clamps and treats unknown as the middle', () => {
  expect(stepSize([11, 12, 14], 12, 1)).toBe(14)
  expect(stepSize([11, 12, 14], 14, 1)).toBe(14)
  expect(stepSize([11, 12, 14], 11, -1)).toBe(11)
  expect(stepSize([11, 12, 14], 99, -1)).toBe(11)
})

test('nextChatLimit', () => {
  expect(nextChatLimit(60)).toBe(200)
  expect(nextChatLimit(200)).toBe(500)
  expect(nextChatLimit(500)).toBeNull()
})

test('sameGroup: same speaker within 2 minutes', () => {
  expect(sameGroup(m({}), m({ ts: 1_000_000 + 60_000 }))).toBe(true)
  expect(sameGroup(m({}), m({ ts: 1_000_000 + 3 * 60_000 }))).toBe(false)
  expect(sameGroup(m({}), m({ role: 'user', kind: 'user' }))).toBe(false)
  expect(sameGroup(m({ kind: 'command' }), m({ kind: 'command' }))).toBe(false)
  expect(sameGroup(m({ ts: null }), m({}))).toBe(false)
  expect(sameGroup(m({}), undefined)).toBe(false)
})

test('visibleMessages hides interim notes on demand', () => {
  const list = [m({ final: false }), m({ final: true }), m({ role: 'user', kind: 'user' })]
  expect(visibleMessages(list, false)).toHaveLength(3)
  expect(visibleMessages(list, true)).toHaveLength(2)
  expect(visibleMessages(null, true)).toEqual([])
})

test('nearBottom', () => {
  expect(nearBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 400 }, 60)).toBe(true)
  expect(nearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 }, 60)).toBe(false)
})
