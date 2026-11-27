import { describe, expect, it } from 'vitest'

import { CHAT_MIN_W, clampChatWidth, defaultChatWidth } from '@/lib/chatWidth'

describe('chat panel width', () => {
  it('stays between its minimum and what leaves the diff room', () => {
    expect(clampChatWidth(100, 1600)).toBe(CHAT_MIN_W)
    expect(clampChatWidth(700, 1600)).toBe(700)
    expect(clampChatWidth(1500, 1600)).toBe(1120)
    expect(clampChatWidth(600, 500)).toBe(CHAT_MIN_W)
  })
  it('defaults to 28rem, 32rem on wide screens', () => {
    expect(defaultChatWidth(1200)).toBe(448)
    expect(defaultChatWidth(1440)).toBe(512)
  })
})
