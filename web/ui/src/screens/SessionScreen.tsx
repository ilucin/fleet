import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeftIcon, CircleAlertIcon, EllipsisIcon, MessageSquareTextIcon, PanelRightIcon, SquareTerminalIcon, WifiOffIcon } from 'lucide-react'
import { useLocation } from 'wouter'
import { toast } from 'sonner'

import { ApiError, api, isAbortError, isSessionGone, sessionErrorMessage } from '@/api/client'
import type { Message, SessionKey } from '@/api/types'
import { ContextMeter } from '@/components/ContextMeter'
import { HostBadge } from '@/components/HostBadge'
import { StatusDot } from '@/components/StatusDot'
import { ChatView } from '@/components/session/ChatView'
import { Composer } from '@/components/session/Composer'
import { SessionMenu, SessionMenuBody, type SessionMenuProps } from '@/components/session/SessionMenu'
import { TermView } from '@/components/session/TermView'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useFleet } from '@/hooks/useFleet'
import { useNow } from '@/hooks/useNow'
import { usePersistentState } from '@/hooks/usePersistentState'
import { usePoller } from '@/hooks/usePoller'
import { useSettings } from '@/hooks/useSettings'
import {
  CHAT_FONT_SIZES,
  CHAT_LIMITS,
  CHAT_POLL_MS,
  PEEK_POLL_MS,
  TERM_FONT_SIZES,
  TERM_LINES,
  nextChatLimit,
  parseMode,
  parseSize,
  stepSize,
  type DetailMode,
} from '@/lib/chat'
import { relTime, shortCwd } from '@/lib/format'
import { findSession, statusMeta, withoutSession } from '@/lib/sessions'
import { STATUS_TEXT } from '@/lib/styles'
import { cn } from '@/lib/utils'

interface ChatState {
  messages: Message[]
  truncated: boolean
  status: string
  name: string | null
  at: number
  /** JSON of the payload, to skip re-renders when a poll brings nothing new. */
  key: string
}
interface PeekState {
  text: string
  at: number
}

const parseBool01 = (raw: string) => (raw === '1' ? true : raw === '0' ? false : undefined)

/** What the desktop shell's shortcuts can ask of the open pane. */
export interface PaneApi {
  setMode: (m: DetailMode) => void
  focusComposer: () => void
}

export interface SessionScreenProps {
  host: string
  id: string
  /** `screen` (mobile, default): fixed full-screen page. `pane`: the desktop detail pane. */
  layout?: 'screen' | 'pane'
  /** Pane only: show the details column (⋯ toggles it instead of opening the drawer). */
  inspector?: boolean
  onToggleInspector?: () => void
  /** Pane only: filled with the pane's API while mounted. */
  paneRef?: React.RefObject<PaneApi | null>
  /** Pane only: focus the composer on mount (opened with Enter). */
  autoFocusComposer?: boolean
}

/**
 * Session detail — `#/s/:host/:id`: Chat (transcript, polls `messages` every 3s) or Term
 * (pane capture, polls `peek` every 2s) — exactly one loop runs, the other is disabled.
 * Shared composer with quick replies + key chips; ⋯ opens the session menu (drawer).
 */
export function SessionScreen({
  host,
  id,
  layout = 'screen',
  inspector = false,
  onToggleInspector,
  paneRef,
  autoFocusComposer = false,
}: SessionScreenProps) {
  const pane = layout === 'pane'
  const { fleet, refresh: refreshFleet, applyFleet } = useFleet()
  const settings = useSettings()
  const [, navigate] = useLocation()
  const now = useNow(1000)
  const session = findSession(fleet, host, id)
  const hostEntry = fleet?.hosts.find((h) => h.name === host) ?? null

  // View prefs (localStorage keys shared with the classic UI).
  const [mode, setMode] = usePersistentState<DetailMode>('fleet.detailMode', 'chat', parseMode)
  const [termFont, setTermFont] = usePersistentState<number>('fleet.termFont', 12, parseSize(TERM_FONT_SIZES))
  const [termLines, setTermLines] = usePersistentState<number>('fleet.termLines', 200, parseSize(TERM_LINES))
  const [chatFont, setChatFont] = usePersistentState<number>('fleet.chatFont', 15, parseSize(CHAT_FONT_SIZES))
  const [hideNotesRaw, setHideNotesRaw] = usePersistentState<string>('fleet.chatHideNotes', '0', (r) =>
    parseBool01(r) === undefined ? undefined : r,
  )
  const hideNotes = hideNotesRaw === '1'

  const [menuOpen, setMenuOpen] = useState(false)
  const [jumpSignal, setJumpSignal] = useState(0)

  const composerRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!paneRef) return
    paneRef.current = { setMode, focusComposer: () => composerRef.current?.focus() }
    return () => {
      paneRef.current = null
    }
  }, [paneRef, setMode])
  useEffect(() => {
    if (autoFocusComposer) composerRef.current?.focus()
  }, [autoFocusComposer])

  // --- chat loop -----------------------------------------------------------
  const [chat, setChat] = useState<ChatState | null>(null)
  const [chatErr, setChatErr] = useState<ApiError | Error | null>(null)
  const [chatLimit, setChatLimit] = useState<number>(CHAT_LIMITS[0])
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [msgBackend, setMsgBackend] = useState<string | null>(null)

  // --- term loop -----------------------------------------------------------
  const [peek, setPeek] = useState<PeekState | null>(null)
  const [peekErr, setPeekErr] = useState<ApiError | Error | null>(null)
  const [peekBackend, setPeekBackend] = useState<string | null>(null)

  const [gone, setGone] = useState(false)
  const [sending, setSending] = useState(false)

  const pollChat = useCallback(
    async (signal: AbortSignal) => {
      try {
        const data = await api.messages(host, id, chatLimit, { signal })
        const messages = Array.isArray(data.messages) ? data.messages : []
        const truncated = data.truncated === true
        const status = String(data.status || 'unknown')
        const name = typeof data.name === 'string' && data.name ? data.name : null
        const key = JSON.stringify([messages, truncated, status, name])
        const at = data.capturedAt || Date.now()
        setChat((prev) => (prev?.key === key ? { ...prev, at } : { messages, truncated, status, name, at, key }))
        if (data.backend) setMsgBackend(String(data.backend))
        setChatErr(null)
        setGone(false)
      } catch (err) {
        if (isAbortError(err)) throw err
        // 404 is usually "no transcript on disk yet"; "unknown session" means it is gone.
        setChatErr(err as Error)
        if (isSessionGone(err)) setGone(true)
      } finally {
        if (!signal.aborted) setLoadingOlder(false)
      }
    },
    [host, id, chatLimit],
  )

  const pollPeek = useCallback(
    async (signal: AbortSignal) => {
      try {
        const data = await api.peek(host, id, termLines, { signal })
        const text = typeof data.text === 'string' ? data.text : ''
        const at = data.capturedAt || Date.now()
        setPeek((prev) => (prev && prev.text === text ? { ...prev, at } : { text, at }))
        setPeekBackend(String(data.backend || 'unknown'))
        setPeekErr(null)
        setGone(false)
      } catch (err) {
        if (isAbortError(err)) throw err
        setPeekErr(err as Error)
        if (err instanceof ApiError && err.status === 404) setGone(true)
        if (err instanceof ApiError && err.status === 409) setPeekBackend('unknown')
      }
    },
    [host, id, termLines],
  )

  const refreshChat = usePoller(pollChat, CHAT_POLL_MS, { enabled: mode === 'chat' })
  const refreshPeek = usePoller(pollPeek, PEEK_POLL_MS, { enabled: mode === 'term' })
  const refreshActive = mode === 'chat' ? refreshChat : refreshPeek

  // Limit / lines changes re-poll now (the poller always calls the latest fn).
  const firstLimit = useRef(true)
  useEffect(() => {
    if (firstLimit.current) {
      firstLimit.current = false
      return
    }
    refreshChat()
  }, [chatLimit, refreshChat])
  const firstLines = useRef(true)
  useEffect(() => {
    if (firstLines.current) {
      firstLines.current = false
      return
    }
    setPeek(null)
    refreshPeek()
  }, [termLines, refreshPeek])

  // Follow-up polls after steering, so the answer shows up quickly.
  const followUps = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const timers = followUps.current
    return () => {
      for (const t of timers) clearTimeout(t)
      timers.clear()
    }
  }, [])
  const refreshActiveRef = useRef(refreshActive)
  useEffect(() => {
    refreshActiveRef.current = refreshActive
  }, [refreshActive])
  const scheduleFollowUps = () => {
    for (const delay of [800, 2000]) {
      const t = setTimeout(() => {
        followUps.current.delete(t)
        refreshActiveRef.current()
      }, delay)
      followUps.current.add(t)
    }
  }

  // --- derived -------------------------------------------------------------
  const backend = (() => {
    if (peekBackend === 'unknown' || (peekErr instanceof ApiError && peekErr.status === 409)) return 'unknown'
    return peekBackend || msgBackend || (session?.backend ? String(session.backend) : null)
  })()
  const status = gone ? 'unknown' : mode === 'chat' && chat ? chat.status : String(session?.status || 'unknown')
  const meta = statusMeta(status)
  const updatedAt = mode === 'chat' ? chat?.at : peek?.at
  const lockedReason = gone
    ? 'Session is gone — nothing to steer.'
    : backend === 'unknown'
      ? "Backend is unknown — this session can't be steered."
      : null

  const activeErr = mode === 'chat' ? chatErr : peekErr
  const noTranscript = mode === 'chat' && chatErr instanceof ApiError && chatErr.status === 404 && !isSessionGone(chatErr)
  const errText = !activeErr || gone ? null : noTranscript ? (chat ? 'No transcript for this session yet' : null) : sessionErrorMessage(activeErr)
  const hostDown = hostEntry?.ok === false
  const missing = !!fleet && !hostDown && !session

  // --- actions -------------------------------------------------------------
  const afterSteer = () => {
    setJumpSignal((n) => n + 1)
    scheduleFollowUps()
  }
  const steerError = (err: unknown) => {
    if (isAbortError(err)) return
    if (err instanceof ApiError && err.status === 404) setGone(true)
    toast.error(sessionErrorMessage(err))
  }

  const send = async (text: string): Promise<boolean> => {
    if (sending || lockedReason || !text.trim()) return false
    setSending(true)
    try {
      await api.send(host, id, text)
      toast.success('Sent', { duration: 1500 })
      afterSteer()
      return true
    } catch (err) {
      steerError(err)
      return false
    } finally {
      setSending(false)
    }
  }

  const sendKey = async (key: SessionKey) => {
    if (sending || lockedReason) return
    setSending(true)
    try {
      await api.keys(host, id, key)
      toast.success(`${key} sent`, { duration: 1200 })
      afterSteer()
    } catch (err) {
      steerError(err)
    } finally {
      setSending(false)
    }
  }

  const back = () => {
    if (window.history.length > 1) window.history.back()
    else navigate('/', { replace: true })
  }

  const fontSizes = mode === 'chat' ? CHAT_FONT_SIZES : TERM_FONT_SIZES
  const fontSize = mode === 'chat' ? chatFont : termFont
  const bumpFont = (dir: 1 | -1) =>
    mode === 'chat' ? setChatFont(stepSize(CHAT_FONT_SIZES, chatFont, dir)) : setTermFont(stepSize(TERM_FONT_SIZES, termFont, dir))

  const loadOlder = () => {
    const next = nextChatLimit(chatLimit)
    if (!next) return
    setLoadingOlder(true)
    setChatLimit(next)
  }

  const name = session?.name || chat?.name || id.slice(0, 8)

  const menuProps: SessionMenuProps = {
    open: menuOpen,
    onOpenChange: setMenuOpen,
    host,
    id,
    session,
    isSelfHost: settings.self != null && settings.self === host,
    mode,
    onMode: setMode,
    hideNotes,
    onHideNotes: (v) => setHideNotesRaw(v ? '1' : '0'),
    fontSize,
    fontSizes,
    onFont: bumpFont,
    termLines,
    onTermLines: setTermLines,
    onClosed: () => {
      // Drop it from the list now; the next polls confirm (discovery caches ~2s).
      if (fleet) applyFleet(withoutSession(fleet, host, id))
      setTimeout(refreshFleet, 2500)
      navigate('/', { replace: true })
    },
  }

  const column = (
    <>
      <header className="z-20 shrink-0 border-b bg-background/90 pt-safe px-safe backdrop-blur-md backdrop-saturate-150">
        <div
          className={
            pane ? 'flex w-full items-center gap-1 py-1.5 pr-2 pl-4' : 'mx-auto flex w-full max-w-3xl items-center gap-1 py-1.5 pr-2 pl-1'
          }
        >
          {pane ? null : (
            <Button variant="ghost" size="icon" aria-label="Back" onClick={back} className="size-11 shrink-0 rounded-xl">
              <ChevronLeftIcon className="size-6" />
            </Button>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] leading-tight font-bold">{name}</div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap">
              <StatusDot status={status} className="size-2" />
              <span className={cn('shrink-0', STATUS_TEXT[meta.key])}>{gone ? 'gone' : meta.label}</span>
              <HostBadge host={host} className="h-4 px-1 text-[10px]" />
              <ContextMeter context={session?.context} />
              {pane && session?.cwd ? (
                <span className="min-w-0 shrink truncate font-mono text-[11px] text-dimmer" title={session.cwd}>
                  · {shortCwd(session.cwd, 60)}
                </span>
              ) : null}
              <span className="truncate text-dimmer tabular-nums">
                {updatedAt ? `· ${relTime(updatedAt, now)} ago` : '· connecting…'}
              </span>
            </div>
          </div>
          <ToggleGroup
            type="single"
            value={mode}
            onValueChange={(v) => v && setMode(v as DetailMode)}
            spacing={0}
            aria-label="View mode"
            className="shrink-0 rounded-xl bg-muted p-0.5"
          >
            <ToggleGroupItem value="chat" aria-label="Chat view" title={pane ? 'Chat (g c)' : undefined} className={modeItem}>
              <MessageSquareTextIcon />
            </ToggleGroupItem>
            <ToggleGroupItem value="term" aria-label="Terminal view" title={pane ? 'Terminal (g t)' : undefined} className={modeItem}>
              <SquareTerminalIcon />
            </ToggleGroupItem>
          </ToggleGroup>
          {pane ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Details panel"
              title="Details panel (i)"
              aria-pressed={inspector}
              onClick={onToggleInspector}
              className={cn('size-11 shrink-0 rounded-xl', inspector && 'bg-muted text-foreground')}
            >
              <PanelRightIcon className="size-5" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              aria-label="More"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
              className="size-11 shrink-0 rounded-xl"
            >
              <EllipsisIcon className="size-5" />
            </Button>
          )}
        </div>
      </header>

      {hostDown || missing ? (
        <div className="shrink-0 px-3 px-safe">
          <div
            className={cn(
              pane
                ? 'mx-auto mt-2 flex max-w-4xl items-start gap-2 rounded-lg border px-3 py-2 text-xs'
                : 'mx-auto mt-2 flex max-w-3xl items-start gap-2 rounded-lg border px-3 py-2 text-xs',
              hostDown ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-card text-muted-foreground',
            )}
          >
            {hostDown ? <WifiOffIcon className="mt-px size-3.5 shrink-0" /> : <CircleAlertIcon className="mt-px size-3.5 shrink-0" />}
            <span className="break-words">
              {hostDown
                ? `${host} unreachable: ${hostEntry?.error || 'no response'}`
                : gone
                  ? 'This session has ended.'
                  : 'Not in the fleet list right now — it may have ended.'}
            </span>
          </div>
        </div>
      ) : null}

      <main className="relative flex min-h-0 flex-1 flex-col">
        {mode === 'chat' ? (
          <ChatView
            messages={chat?.messages ?? null}
            noTranscript={noTranscript}
            gone={gone}
            hideNotes={hideNotes}
            fontSize={chatFont}
            status={status}
            waitingFor={session?.waiting_for}
            canLoadOlder={!!chat?.truncated && chatLimit < CHAT_LIMITS[CHAT_LIMITS.length - 1]}
            loadingOlder={loadingOlder}
            onLoadOlder={loadOlder}
            jumpSignal={jumpSignal}
            wide={pane}
          />
        ) : (
          <TermView text={peek?.text ?? null} failed={!!peekErr} fontSize={termFont} jumpSignal={jumpSignal} />
        )}
        {errText ? (
          <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center px-3">
            <div className="flex max-w-full items-center gap-2 rounded-full border border-destructive/40 bg-popover/95 px-3 py-1.5 text-xs text-destructive shadow-md backdrop-blur-sm">
              <CircleAlertIcon className="size-3.5 shrink-0" />
              <span className="truncate">{errText}</span>
            </div>
          </div>
        ) : null}
      </main>

      <Composer
        quickReplies={settings.quickReplies}
        lockedReason={lockedReason}
        sending={sending}
        onSend={send}
        onKey={sendKey}
        desktop={pane}
        inputRef={composerRef}
      />
    </>
  )

  if (pane) {
    return (
      <div className="flex h-full min-w-0 flex-1 overflow-hidden bg-background">
        <section aria-label={`Session ${name}`} className="flex min-w-0 flex-1 flex-col">
          {column}
        </section>
        {inspector ? (
          <aside aria-label="Session details" className="w-80 shrink-0 border-l bg-card/30">
            <SessionMenuBody {...menuProps} open variant="panel" />
          </aside>
        ) : null}
      </div>
    )
  }

  return (
    <div className="fixed-app flex flex-col overflow-hidden bg-background">
      {column}
      <SessionMenu {...menuProps} />
    </div>
  )
}

const modeItem =
  'size-10 rounded-[10px] text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:bg-accent [&_svg:not([class*=size-])]:size-[18px]'
