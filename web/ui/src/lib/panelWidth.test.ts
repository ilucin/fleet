import { describe, expect, it } from 'vitest'

import { CHAT_MIN_W, TREE_MIN_W, clampPanelWidth, defaultChatWidth } from '@/lib/panelWidth'

describe('side panel width', () => {
  it('stays between its minimum and what leaves the diff room', () => {
    expect(clampPanelWidth(100, 1600, CHAT_MIN_W)).toBe(CHAT_MIN_W)
    expect(clampPanelWidth(700, 1600, CHAT_MIN_W)).toBe(700)
    expect(clampPanelWidth(1500, 1600, CHAT_MIN_W)).toBe(1120)
    expect(clampPanelWidth(600, 500, CHAT_MIN_W)).toBe(CHAT_MIN_W)
    expect(clampPanelWidth(100, 1600, TREE_MIN_W)).toBe(TREE_MIN_W)
  })
  it('defaults the chat to 28rem, 32rem on wide screens', () => {
    expect(defaultChatWidth(1200)).toBe(448)
    expect(defaultChatWidth(1440)).toBe(512)
  })
})
