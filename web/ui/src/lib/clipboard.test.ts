import { describe, expect, test } from 'vitest'

import { attachCommand, sessionAttachCommand, shellQuote } from './clipboard'

describe('shellQuote', () => {
  test('safe words stay plain', () => {
    expect(shellQuote('update-school-schedule')).toBe('update-school-schedule')
    expect(shellQuote('api_v2.1')).toBe('api_v2.1')
  })
  test('anything else is single-quoted, quotes escaped', () => {
    expect(shellQuote('my session')).toBe("'my session'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote('$HOME;rm')).toBe("'$HOME;rm'")
    expect(shellQuote('')).toBe("''")
  })
})

describe('attachCommand', () => {
  test('host and session name', () => {
    expect(attachCommand('workstation', 'fleet-web')).toBe('fleet -H workstation enter fleet-web')
    expect(attachCommand('laptop', 'a b')).toBe("fleet -H laptop enter 'a b'")
  })
  test('a name that looks like a flag goes after --', () => {
    expect(attachCommand('laptop', '-x')).toBe('fleet -H laptop enter -- -x')
  })
})

describe('sessionAttachCommand', () => {
  test('tmux-backed sessions only', () => {
    expect(sessionAttachCommand({ host: 'workstation', backend: 'tmux', tmux_session: 'api' })).toBe('fleet -H workstation enter api')
    expect(sessionAttachCommand({ host: 'laptop', backend: 'iterm', tmux_session: null })).toBeNull()
    expect(sessionAttachCommand({ host: 'laptop', backend: 'tmux', tmux_session: '' })).toBeNull()
    expect(sessionAttachCommand(null)).toBeNull()
  })
})
