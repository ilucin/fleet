import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import { ChevronsUpIcon, HandIcon, Loader2Icon, MessageSquareDashedIcon } from 'lucide-react'

import type { Message } from '@/api/types'
import { LatestButton } from '@/components/session/LatestButton'
import { Markdown } from '@/components/Markdown'
import { Button } from '@/components/ui/button'
import { useFollowScroll } from '@/hooks/useFollowScroll'
import { useNow } from '@/hooks/useNow'
import { clockTime } from '@/lib/format'
import { msgKind, sameGroup, visibleMessages } from '@/lib/chat'
import { cn } from '@/lib/utils'

export interface ChatViewProps {
  /** null = not loaded yet. */
  messages: Message[] | null
  /** No transcript on disk (404 from /messages). */
  noTranscript: boolean
  /** The session no longer exists. */
  gone?: boolean
  hideNotes: boolean
  fontSize: number
  status: string
  waitingFor?: string | null
  /** Older messages exist and a bigger limit is available. */
  canLoadOlder: boolean
  loadingOlder: boolean
  onLoadOlder: () => void
  /** Bumped by the parent to jump to the bottom (after a send). */
  jumpSignal: number
  /** Desktop pane: a wider (still readable) column. */
  wide?: boolean
}

const Bubble = memo(function Bubble({ m, caption }: { m: Message; caption: string }) {
  const kind = msgKind(m)
  const text = typeof m.text === 'string' ? m.text : ''
  if (kind === 'command') {
    return (
      <div className="self-center text-center">
        <span className="inline-block rounded-full border bg-muted px-2.5 py-0.5 font-mono text-[11px] break-words text-status-waiting/90">
          {text}
        </span>
      </div>
    )
  }
  if (kind === 'system') {
    return <div className="max-w-[92%] self-center text-center text-[11px] break-words text-dimmer">{text}</div>
  }
  const cap = caption ? <div className="px-1 pt-0.5 text-[10px] text-dimmer tabular-nums">{caption}</div> : null
  if (kind === 'user') {
    return (
      <div className="flex max-w-[85%] flex-col items-end self-end">
        <div className="rounded-2xl rounded-br-md border border-primary/25 bg-accent px-3 py-2 break-words whitespace-pre-wrap text-accent-foreground [overflow-wrap:anywhere]">
          {text}
        </div>
        {cap}
      </div>
    )
  }
  if (m.final === false) {
    return (
      <div className="flex max-w-[94%] flex-col items-start self-start">
        <Markdown text={text} className="border-l-2 border-border pl-2.5 text-[0.86em] leading-normal text-muted-foreground" />
        {cap}
      </div>
    )
  }
  return (
    <div className="flex w-[94%] flex-col items-start self-start">
      <div className="w-full rounded-2xl rounded-bl-md border border-border/70 bg-card px-3 py-2 text-card-foreground">
        <Markdown text={text} />
      </div>
      {cap}
    </div>
  )
})

function Typing({ status, waitingFor }: { status: string; waitingFor?: string | null }) {
  if (status === 'busy') {
    return (
      <div className="flex items-center gap-2 px-1 pt-3 text-xs text-dimmer" aria-live="polite">
        <span className="inline-flex gap-[3px]" aria-hidden>
          {[0, 0.18, 0.36].map((d) => (
            <i key={d} className="size-[5px] animate-dot rounded-full bg-status-busy motion-reduce:animate-none" style={{ animationDelay: `${d}s` }} />
          ))}
        </span>
        Claude is working…
      </div>
    )
  }
  if (status === 'waiting') {
    return (
      <div className="flex items-center gap-2 px-1 pt-3 text-xs font-medium text-status-waiting" aria-live="polite">
        <HandIcon className="size-3.5" />
        Needs you{waitingFor?.trim() ? ` · ${waitingFor.trim()}` : ' — Claude is waiting for an answer'}
      </div>
    )
  }
  return null
}

/** Conversation view: bubbles, markdown, "Load older", follow-scroll with "↓ latest". */
export function ChatView(p: ChatViewProps) {
  const { ref, following, setFollow, setTop, stick, jump, onScroll } = useFollowScroll<HTMLDivElement>(60)
  const list = visibleMessages(p.messages, p.hideNotes)
  const now = useNow(60_000) // captions: "today" vs a date

  // Remember the scroll geometry of the last commit, so "Load older" (which prepends)
  // can keep the same message under the thumb.
  const lastHeight = useRef(0)
  const anchorPending = useRef(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (p.loadingOlder) anchorPending.current = true
    else if (anchorPending.current) {
      anchorPending.current = false
      setFollow(false)
      setTop(el.scrollTop + (el.scrollHeight - lastHeight.current))
    } else stick()
    lastHeight.current = el.scrollHeight
  }, [p.messages, p.hideNotes, p.fontSize, p.status, p.loadingOlder, ref, setFollow, setTop, stick])

  useEffect(() => {
    if (p.jumpSignal) jump()
  }, [p.jumpSignal, jump])

  let body
  if (p.messages === null) {
    body = p.gone ? (
      <Empty icon={<MessageSquareDashedIcon className="size-6" />} text="This session has ended" />
    ) : p.noTranscript ? (
      <Empty icon={<MessageSquareDashedIcon className="size-6" />} text="No transcript for this session yet" />
    ) : (
      <Empty icon={<Loader2Icon className="size-5 animate-spin" />} text="Loading conversation…" />
    )
  } else if (list.length === 0) {
    body = (
      <Empty
        icon={<MessageSquareDashedIcon className="size-6" />}
        text={p.messages.length ? 'Only progress notes here — show them from the ⋯ menu' : 'No messages yet'}
      />
    )
  } else {
    body = (
      <div className="flex flex-col gap-2.5">
        {list.map((m, i) => (
          <Bubble key={i} m={m} caption={sameGroup(m, list[i + 1]) ? '' : clockTime(m.ts, now)} />
        ))}
      </div>
    )
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        onScroll={onScroll}
        tabIndex={0}
        aria-label="Conversation"
        className="absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-contain px-safe outline-none [overflow-anchor:none]"
        style={{ fontSize: p.fontSize, lineHeight: 1.5 }}
      >
        <div className={p.wide ? 'mx-auto w-full max-w-4xl px-4 pt-3 pb-4' : 'mx-auto w-full max-w-3xl px-3 pt-3 pb-4'}>
          {p.canLoadOlder || p.loadingOlder ? (
            <div className="flex justify-center pb-3">
              <Button variant="outline" size="sm" className="h-8 rounded-full px-3.5" disabled={p.loadingOlder} onClick={p.onLoadOlder}>
                {p.loadingOlder ? <Loader2Icon className="animate-spin" /> : <ChevronsUpIcon />}
                {p.loadingOlder ? 'Loading…' : 'Load older'}
              </Button>
            </div>
          ) : null}
          {body}
          {p.messages ? <Typing status={p.status} waitingFor={p.waitingFor} /> : null}
        </div>
      </div>
      <LatestButton show={!following} onClick={jump} />
    </div>
  )
}

function Empty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-2 px-4 py-14 text-center text-sm text-dimmer')}>
      {icon}
      {text}
    </div>
  )
}
