import { useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDownIcon, ArrowUpIcon, CornerDownLeftIcon, Loader2Icon, SendHorizontalIcon } from 'lucide-react'

import type { QuickReply, SessionKey } from '@/api/types'
import { Button } from '@/components/ui/button'
import { MAX_SEND_CHARS } from '@/lib/chat'
import { cn } from '@/lib/utils'

/** Built-in key chips (not configurable), as in the classic UI. */
const KEY_CHIPS: { key: SessionKey; label: string; icon?: ReactNode }[] = [
  { key: 'Escape', label: 'Esc' },
  { key: 'Enter', label: 'Enter', icon: <CornerDownLeftIcon /> },
  { key: 'Up', label: 'Up', icon: <ArrowUpIcon /> },
  { key: 'Down', label: 'Down', icon: <ArrowDownIcon /> },
]

// Visually 40px, with the hit area stretched to 44px.
const chipClass = cn(
  'relative h-10 shrink-0 rounded-full border border-border bg-card px-3.5 text-sm font-medium text-muted-foreground transition-colors',
  'after:absolute after:inset-x-0 after:-inset-y-0.5 active:bg-muted active:text-foreground disabled:opacity-50',
  'hover:text-foreground',
)

export interface ComposerProps {
  quickReplies: QuickReply[]
  /** Why steering is impossible (gone / unknown backend); null = enabled. */
  lockedReason: string | null
  sending: boolean
  /** Resolves true when the text was delivered (the textarea is then cleared). */
  onSend: (text: string) => Promise<boolean>
  onKey: (key: SessionKey) => void
  /**
   * Desktop pane: Enter (or ⌘/Ctrl+Enter) always sends, even on touch-capable laptops;
   * Shift+Enter is a newline; wider column. Mobile (false): Enter sends only on hardware keyboards.
   */
  desktop?: boolean
  /** The textarea, for "reply" shortcuts. */
  inputRef?: React.Ref<HTMLTextAreaElement>
}

const MAX_TEXTAREA_PX = 21 * 5 + 22 // ~5 rows + padding

export function Composer({ quickReplies, lockedReason, sending, onSend, onKey, desktop = false, inputRef }: ComposerProps) {
  const [text, setText] = useState('')
  const ta = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(inputRef, () => ta.current as HTMLTextAreaElement, [])
  const locked = lockedReason != null
  const empty = text.trim().length === 0
  const tooLong = text.length > MAX_SEND_CHARS

  // Auto-grow up to ~5 rows, then scroll inside.
  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(MAX_TEXTAREA_PX, Math.max(44, el.scrollHeight))}px`
  }, [text])

  const submit = async () => {
    if (locked || sending || empty || tooLong) return
    if (await onSend(text)) setText('')
  }

  // Hardware keyboards send on Enter; touch keyboards keep Enter as a newline.
  const isTouch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0

  return (
    <div className="shrink-0 border-t bg-background/95 pb-safe px-safe backdrop-blur-md">
      <form
        className={cn(desktop ? 'mx-auto w-full max-w-4xl px-4 pt-2 pb-2' : 'mx-auto w-full max-w-3xl px-3 pt-2 pb-2', locked && 'opacity-60')}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="no-scrollbar -mx-3 flex gap-1.5 overflow-x-auto px-3 pt-0.5 pb-2" role="toolbar" aria-label="Quick replies and keys">
          {quickReplies.map((q) => (
            <button
              key={`${q.label}\u0000${q.text}`}
              type="button"
              className={chipClass}
              disabled={locked || sending}
              title={q.text}
              onClick={() => void onSend(q.text)}
            >
              {q.label}
            </button>
          ))}
          <span aria-hidden className="mx-0.5 my-2 w-px shrink-0 bg-border" />
          {KEY_CHIPS.map((k) => (
            <button
              key={k.key}
              type="button"
              aria-label={`Press ${k.label}`}
              title={`Press ${k.label}`}
              className={cn(
                chipClass,
                'flex items-center px-3 font-mono text-[13px] text-status-waiting/90 [&_svg]:size-4',
              )}
              disabled={locked || sending}
              onClick={() => onKey(k.key)}
            >
              {k.icon ?? k.label}
            </button>
          ))}
        </div>

        <div className="flex items-end gap-2">
          <textarea
            ref={ta}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (isTouch && !desktop) return
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
            disabled={locked}
            placeholder={locked ? 'Read-only' : desktop ? 'Message Claude…  (Enter to send, Shift+Enter for a new line)' : 'Message Claude…'}
            aria-label="Message"
            autoCapitalize="sentences"
            autoComplete="off"
            spellCheck={false}
            className={cn(
              'min-h-11 min-w-0 flex-1 resize-none rounded-[22px] border border-input bg-card px-4 py-[11px] text-base leading-[21px]',
              'transition-colors outline-none placeholder:text-dimmer focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40',
              'disabled:cursor-not-allowed',
              tooLong && 'border-destructive',
            )}
          />
          <Button
            type="submit"
            size="icon"
            aria-label="Send"
            disabled={locked || sending || empty || tooLong}
            className="size-11 rounded-full [&_svg:not([class*='size-'])]:size-5"
          >
            {sending ? <Loader2Icon className="animate-spin" /> : <SendHorizontalIcon />}
          </Button>
        </div>
        {lockedReason || text.length > MAX_SEND_CHARS - 1000 ? (
          <div className={cn('px-2 pt-1.5 text-xs', tooLong ? 'text-destructive' : 'text-dimmer')}>
            {lockedReason ?? `${text.length} / ${MAX_SEND_CHARS}`}
          </div>
        ) : null}
      </form>
    </div>
  )
}
