// Copying text, and the `fleet enter` command that attaches to a session's tmux session.

import { toast } from 'sonner'

import type { Session } from '@/api/types'

/** A word as the shell reads it: plain when safe, else single-quoted ('\'' for a quote). */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** `fleet -H <host> enter <tmux session>` — `--` first when the name looks like a flag. */
export function attachCommand(host: string, tmuxSession: string): string {
  const name = shellQuote(tmuxSession)
  return `fleet -H ${shellQuote(host)} enter ${tmuxSession.startsWith('-') ? '-- ' : ''}${name}`
}

/** The attach command for a tmux-backed session; null for any other backend. */
export function sessionAttachCommand(s: Pick<Session, 'host' | 'backend' | 'tmux_session'> | null | undefined): string | null {
  if (!s || s.backend !== 'tmux' || !s.tmux_session) return null
  return attachCommand(s.host, s.tmux_session)
}

/**
 * Copy `text`; → whether it worked. `navigator.clipboard` only exists in a secure
 * context, and the app is usually served over plain http on a tailnet address, so the
 * fallback is a selected off-screen textarea + `execCommand('copy')`. The textarea goes
 * inside the focused dialog, if any — a modal's focus trap would steal the selection.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall through to the legacy path
    }
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none'
  const host = document.activeElement?.closest('[role="dialog"]') ?? document.body
  const prev = document.activeElement as HTMLElement | null
  host.appendChild(ta)
  try {
    ta.focus()
    ta.select()
    ta.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    ta.remove()
    prev?.focus?.()
  }
}

/** Copy `text` and say how it went; when copying is refused the text is in the toast to select. */
export async function copyWithToast(text: string): Promise<void> {
  if (await copyText(text)) toast.success('Copied', { description: text })
  else toast('Select and copy manually', { description: text })
}
