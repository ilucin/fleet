import { describe, expect, it } from 'vitest'

import { isMacPlatform, isTypingTarget, matchShortcut, sessionKey, stepCursor, type ShortcutContext } from '@/lib/shortcuts'

const idle: ShortcutContext = { typing: false, arrowsFree: true, pending: null }
const act = (key: string, ctx: Partial<ShortcutContext> = {}, mods: Record<string, boolean> = {}) =>
  matchShortcut({ key, ...mods }, { ...idle, ...ctx })

describe('matchShortcut', () => {
  it('maps single keys', () => {
    expect(act('j').action).toBe('next')
    expect(act('k').action).toBe('prev')
    expect(act('ArrowDown').action).toBe('next')
    expect(act('ArrowUp').action).toBe('prev')
    expect(act('Enter').action).toBe('openAndReply')
    expect(act('o').action).toBe('open')
    expect(act('/').action).toBe('search')
    expect(act('c').action).toBe('new')
    expect(act('n').action).toBe('new')
    expect(act('Escape').action).toBe('back')
    expect(act('?', {}, { shiftKey: true }).action).toBe('help')
    expect(act('G', {}, { shiftKey: true }).action).toBe('last')
    expect(act('[').action).toBe('sidebar')
    expect(act('i').action).toBe('inspector')
    expect(act('b').action).toBe('view')
    expect(act('r').action).toBe('reply')
    expect(act('x').action).toBeNull()
  })

  it('handles g chords', () => {
    const first = act('g')
    expect(first).toEqual({ action: null, pending: 'g' })
    expect(act('t', { pending: 'g' })).toEqual({ action: 'term', pending: null })
    expect(act('c', { pending: 'g' })).toEqual({ action: 'chat', pending: null })
    expect(act('g', { pending: 'g' })).toEqual({ action: 'first', pending: null })
    expect(act('r', { pending: 'g' })).toEqual({ action: 'refresh', pending: null })
    // An unknown second key cancels the chord instead of firing its own shortcut.
    expect(act('j', { pending: 'g' })).toEqual({ action: null, pending: null })
  })

  it('never steals keys while typing, except the palette and Esc', () => {
    for (const k of ['j', 'k', '/', 'c', 'Enter', 'g', '?', 'ArrowDown']) expect(act(k, { typing: true }).action).toBeNull()
    expect(act('Escape', { typing: true }).action).toBe('blur')
    expect(act('k', { typing: true }, { metaKey: true }).action).toBe('palette')
    expect(act('K', { typing: true }, { ctrlKey: true }).action).toBe('palette')
    expect(act('b', { typing: true }, { metaKey: true }).action).toBeNull()
  })

  it('leaves other modifier combos to the browser', () => {
    expect(act('j', {}, { metaKey: true }).action).toBeNull()
    expect(act('c', {}, { ctrlKey: true }).action).toBeNull() // copy
    expect(act('k', {}, { altKey: true }).action).toBeNull()
    expect(act('b', {}, { metaKey: true }).action).toBe('sidebar')
    expect(act('k', {}, { metaKey: true, shiftKey: true }).action).toBeNull()
  })

  it('leaves arrows alone when focus is in a scrollable pane', () => {
    expect(act('ArrowDown', { arrowsFree: false }).action).toBeNull()
    expect(act('j', { arrowsFree: false }).action).toBe('next')
  })

  it('ignores IME composition', () => {
    expect(act('j', {}, { isComposing: true }).action).toBeNull()
  })
})

describe('isTypingTarget', () => {
  it('detects text fields', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'INPUT', type: 'search' })).toBe(true)
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('stepCursor', () => {
  const keys = ['a', 'b', 'c']
  it('moves and clamps', () => {
    expect(stepCursor(keys, 'a', 1)).toBe('b')
    expect(stepCursor(keys, 'c', 1)).toBe('c')
    expect(stepCursor(keys, 'a', -1)).toBe('a')
    expect(stepCursor(keys, 'b', -1)).toBe('a')
    expect(stepCursor(keys, 'a', 99)).toBe('c')
  })
  it('starts at an end when the cursor is not in the list', () => {
    expect(stepCursor(keys, null, 1)).toBe('a')
    expect(stepCursor(keys, 'zz', -1)).toBe('c')
    expect(stepCursor([], 'a', 1)).toBeNull()
  })
})

describe('helpers', () => {
  it('sessionKey', () => {
    expect(sessionKey({ host: 'laptop', session_id: 'abc' })).toBe('laptop/abc')
  })
  it('isMacPlatform', () => {
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true)
    expect(isMacPlatform({ platform: 'Linux x86_64', userAgent: 'X11' })).toBe(false)
  })
})
