import { describe, expect, it } from 'vitest'

import { detectConnectionKind, keepLabel, keepValue, CONNECTION_KINDS } from '@/lib/connections'

describe('detectConnectionKind', () => {
  it('tells the kind from what was pasted', () => {
    expect(detectConnectionKind('https://acme.slack.com/archives/C0123/p1700000000000100', CONNECTION_KINDS)).toBe('slack')
    expect(detectConnectionKind('@Ana Example', CONNECTION_KINDS)).toBe('slack')
    expect(detectConnectionKind('https://github.com/acme/app/pull/12', CONNECTION_KINDS)).toBe('github')
    expect(detectConnectionKind('https://github.com/acme/app/pull/12/files#diff', CONNECTION_KINDS)).toBe('github')
    expect(detectConnectionKind('acme/app#12', CONNECTION_KINDS)).toBe('github')
    expect(detectConnectionKind('https://app.productive.io/1-acme/tasks/1001', CONNECTION_KINDS)).toBe('productive')
    expect(detectConnectionKind('https://app.productive.io/1-acme/projects/5/tasks/task/1001?x=1', CONNECTION_KINDS)).toBe('productive')
    expect(detectConnectionKind('team-demo', CONNECTION_KINDS)).toBe('veranda')
  })

  it('null for anything else, and for a kind this session cannot have', () => {
    expect(detectConnectionKind('', CONNECTION_KINDS)).toBeNull()
    expect(detectConnectionKind('https://example.com/x', CONNECTION_KINDS)).toBeNull()
    expect(detectConnectionKind('Team Demo', CONNECTION_KINDS)).toBeNull()
    expect(detectConnectionKind('https://github.com/acme/app/issues/3', CONNECTION_KINDS)).toBeNull()
    expect(detectConnectionKind('https://github.com/acme/app/pull/12', ['slack', 'veranda'])).toBeNull()
  })
})

describe('keep', () => {
  it('minutes to the option and the words', () => {
    expect(keepValue(null)).toBeNull()
    expect(keepValue(1440)).toBe('1d')
    expect(keepValue(90)).toBe('90m')
    expect(keepLabel(null)).toBe('never sleeps')
    expect(keepLabel(720)).toBe('sleeps after 12h idle')
    expect(keepLabel(10080)).toBe('sleeps after 7d idle')
  })
})
