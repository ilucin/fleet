// One-shot composer drafts: a screen that opens a session with text to reply with (the notes
// explorer's "Send to session") parks it here; that session's Composer takes it on mount.
const drafts = new Map<string, string>()

export function setDraft(key: string, text: string): void {
  drafts.set(key, text)
}

/** The parked draft for `key` (removed), or ''. */
export function takeDraft(key: string | undefined): string {
  if (!key) return ''
  const text = drafts.get(key) ?? ''
  drafts.delete(key)
  return text
}
