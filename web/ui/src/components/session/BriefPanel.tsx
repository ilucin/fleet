import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowRightIcon,
  CircleAlertIcon,
  CircleDotIcon,
  FileIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitPullRequestIcon,
  LinkIcon,
  Loader2Icon,
  PencilIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  SparklesIcon,
  SquareCheckBigIcon,
  SquareIcon,
  StickyNoteIcon,
  XIcon,
} from 'lucide-react'

import type { BriefResource } from '@/api/types'
import { Markdown } from '@/components/Markdown'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Skeleton } from '@/components/ui/skeleton'
import type { BriefState } from '@/hooks/useBrief'
import { FileLinksContext, type FileStats } from '@/hooks/useFileLinks'
import { useNow } from '@/hooks/useNow'
import { briefBody, briefTime, groupResources, planProgress } from '@/lib/brief'
import { relTime } from '@/lib/format'
import { pathCandidates } from '@/lib/paths'
import { cn } from '@/lib/utils'

const KIND_ICON: Record<string, typeof FileIcon> = {
  PR: GitPullRequestIcon,
  Issue: CircleDotIcon,
  Artifact: SparklesIcon,
  Spec: ScrollTextIcon,
  File: FileIcon,
  Branch: GitBranchIcon,
  Worktree: FolderGit2Icon,
  Link: LinkIcon,
}
/** Kinds whose `path` is a file the preview can show. */
const FILE_KINDS = new Set(['File', 'Spec'])

export interface BriefPanelProps {
  host: string
  brief: BriefState
  /** Chat paths on the session's host: file resources open the in-app preview through it. */
  fileLinks: FileStats
  /** "Continue in new session": the prompt to prefill. */
  onContinue: (prompt: string) => void
  /** `panel` = the desktop right column (has a close button); `drawer` = the mobile bottom sheet. */
  variant: 'panel' | 'drawer'
  onClose?: () => void
  /** Filled with "cancel the edit" while editing (the drawer's Esc cancels it instead of closing). */
  cancelEditRef?: React.RefObject<(() => void) | null>
}

/**
 * The session brief: Summary, Plan (clickable checkboxes, "3/7"), Resources grouped by kind
 * (files open the in-app preview, URLs a new tab). Header: updated / edited, Regenerate, Edit.
 * Edit = the body markdown in a textarea (⌘/Ctrl+Enter saves, Esc cancels).
 */
export function BriefPanel({ host, brief: st, fileLinks, onContinue, variant, onClose, cancelEditRef }: BriefPanelProps) {
  const panel = variant === 'panel'
  const now = useNow(15_000)
  const b = st.brief
  const [draft, setDraft] = useState<string | null>(null)
  const editing = draft !== null
  const textRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!cancelEditRef) return
    cancelEditRef.current = editing ? () => setDraft(null) : null
    return () => {
      cancelEditRef.current = null
    }
  }, [cancelEditRef, editing])
  useEffect(() => {
    if (editing) textRef.current?.focus()
  }, [editing])

  // Which file resources / summary paths exist on the host (same cache as the chat's links).
  const request = fileLinks.request
  const summary = b?.parsed.summary ?? ''
  const resources = b?.parsed.resources
  useEffect(() => {
    const paths = (resources ?? []).filter((r) => r.path && FILE_KINDS.has(String(r.kind))).map((r) => r.path as string)
    if (summary) paths.push(...pathCandidates(summary))
    if (paths.length) request(paths)
  }, [resources, summary, request])

  const startEdit = () => b && setDraft(briefBody(b.markdown))
  const saveEdit = async () => {
    if (draft == null || st.saving) return
    if (await st.save(draft)) setDraft(null)
  }

  const updated = briefTime(b?.updated)
  const edited = briefTime(b?.editedAt)
  const busy = st.generating || st.regenerating
  const plan = b?.parsed.plan ?? []
  const progress = planProgress(plan)
  const groups = groupResources(resources)
  const empty = !!b && !b.exists && !summary && !plan.length && !groups.length

  const Title = panel ? 'h2' : DrawerTitle
  const Description = panel ? 'p' : DrawerDescription
  const Header = panel ? 'div' : DrawerHeader

  const regenerateButton = (label: string, className?: string) => (
    <Button variant="outline" className={cn('h-9 px-3', className)} disabled={busy || !b} onClick={() => void st.regenerate()}>
      {busy ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
      {busy ? 'Generating…' : label}
    </Button>
  )

  return (
    <div className={cn('flex min-h-0 w-full flex-col', panel ? 'h-full' : 'mx-auto max-w-lg flex-1')}>
      <Header className="flex shrink-0 flex-row items-center gap-1 px-4 pt-3 pb-2 text-left">
        <div className="min-w-0 flex-1">
          <Title className="text-left text-base font-semibold">Brief</Title>
          <Description className="truncate text-left text-xs text-dimmer tabular-nums">
            {busy
              ? 'Updating…'
              : !b
                ? st.error
                  ? 'Could not load'
                  : 'Loading…'
                : updated
                  ? `updated ${relTime(updated, now)} ago${edited ? ' · edited' : ''}`
                  : 'not generated yet'}
          </Description>
        </div>
        {!editing ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Regenerate brief"
              title="Regenerate (asks the model)"
              disabled={busy || !b}
              onClick={() => void st.regenerate()}
              className="size-10 shrink-0 rounded-xl"
            >
              {busy ? <Loader2Icon className="size-[18px] animate-spin" /> : <RefreshCwIcon className="size-[18px]" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Edit brief"
              title="Edit"
              disabled={!b}
              onClick={startEdit}
              className="size-10 shrink-0 rounded-xl"
            >
              <PencilIcon className="size-[18px]" />
            </Button>
          </>
        ) : null}
        {panel && onClose ? (
          <Button variant="ghost" size="icon" aria-label="Close brief" title="Close (p)" onClick={onClose} className="size-10 shrink-0 rounded-xl">
            <XIcon className="size-[18px]" />
          </Button>
        ) : null}
      </Header>

      {editing ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-3">
          <textarea
            ref={textRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void saveEdit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setDraft(null)
              }
            }}
            aria-label="Brief markdown"
            data-vaul-no-drag
            spellCheck={false}
            className={cn(
              'min-h-0 w-full flex-1 resize-none rounded-lg border border-input bg-card px-3 py-2 font-mono text-[13px] leading-relaxed outline-none',
              'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
              panel ? 'h-full' : 'h-[50vh]',
            )}
          />
          <div className="flex shrink-0 items-center gap-2 pb-[max(0px,env(safe-area-inset-bottom))]">
            <span className="min-w-0 flex-1 truncate text-xs text-dimmer">{panel ? '⌘/Ctrl+Enter saves · Esc cancels' : 'Sections: Summary, Resources, Plan'}</span>
            <Button variant="ghost" className="h-9 px-3" onClick={() => setDraft(null)} disabled={st.saving}>
              Cancel
            </Button>
            <Button className="h-9 px-4" onClick={() => void saveEdit()} disabled={st.saving}>
              {st.saving ? <Loader2Icon className="animate-spin" /> : null}
              Save
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {!b ? (
              st.error ? (
                <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <CircleAlertIcon className="mt-px size-3.5 shrink-0" />
                  <span className="break-words">{st.error}</span>
                </p>
              ) : (
                <div className="space-y-2 pt-2" aria-hidden>
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-4/5" />
                  <Skeleton className="mt-5 h-4 w-2/3" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              )
            ) : empty ? (
              <div className="space-y-3 pt-2 text-sm text-muted-foreground">
                <p>
                  No brief yet. A brief is a short summary of what this session is doing, its plan and everything it produced
                  (PRs, files, links) — enough to pick the work up in a new session.
                </p>
                {!b.enabled ? (
                  <p className="text-xs text-dimmer">
                    Automatic updates are off on {host} (<code className="font-mono">web.briefs.enabled</code>); generating one by hand works.
                  </p>
                ) : null}
                {regenerateButton('Generate brief', 'w-full')}
              </div>
            ) : (
              <FileLinksContext.Provider value={fileLinks.api}>
                <div className="space-y-5 pt-1">
                  <Section title="Summary">
                    {summary ? (
                      <Markdown text={summary} className="text-sm leading-relaxed" />
                    ) : (
                      <div className="space-y-2">
                        <p className="text-sm text-dimmer">
                          No summary yet.
                          {!b.enabled ? ' Automatic updates are off on this host (web.briefs.enabled); generating one by hand works.' : ''}
                        </p>
                        {regenerateButton('Generate summary')}
                      </div>
                    )}
                  </Section>

                  {plan.length ? (
                    <Section
                      title="Plan"
                      aside={progress ? <span className="tabular-nums">{`${progress.done}/${progress.total}`}</span> : null}
                    >
                      {progress ? (
                        <div className="mb-2 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                          <div className="h-full rounded-full bg-primary/70 transition-[width]" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                        </div>
                      ) : null}
                      <ul className="space-y-0.5">
                        {plan.map((item, i) => (
                          <li key={i} className="flex items-start gap-1">
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={item.done}
                              aria-label={item.done ? `Mark not done: ${item.text}` : `Mark done: ${item.text}`}
                              onClick={() => void st.togglePlan(i)}
                              className="-ml-1.5 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-muted"
                            >
                              {item.done ? <SquareCheckBigIcon className="size-[18px] text-primary" /> : <SquareIcon className="size-[18px]" />}
                            </button>
                            <Markdown text={item.text} className={cn('min-w-0 flex-1 pt-1.5 text-sm', item.done && 'text-dimmer line-through')} />
                          </li>
                        ))}
                      </ul>
                    </Section>
                  ) : null}

                  {groups.length ? (
                    <Section title="Resources">
                      <div className="space-y-3">
                        {groups.map((g) => (
                          <div key={g.kind ?? 'notes'}>
                            <h4 className="pb-1 text-xs font-medium text-muted-foreground">
                              {g.label}
                              {g.items.length > 1 ? <span className="pl-1 text-dimmer tabular-nums">{g.items.length}</span> : null}
                            </h4>
                            <ul className="space-y-1">
                              {g.items.map((r, i) => (
                                <ResourceRow key={`${r.text}-${i}`} r={r} fileLinks={fileLinks} />
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </Section>
                  ) : null}
                </div>
              </FileLinksContext.Provider>
            )}
          </div>
          {b && !empty ? (
            <div className="shrink-0 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <Button variant="outline" className="h-10 w-full rounded-xl" onClick={() => onContinue(b.continuePrompt)}>
                Continue in new session
                <ArrowRightIcon />
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

/** Mobile: the brief as a bottom sheet (from the session ⋯ menu). Esc while editing cancels the edit, not the sheet. */
export function BriefDrawer({
  open,
  onOpenChange,
  ...p
}: Omit<BriefPanelProps, 'variant' | 'cancelEditRef' | 'onClose'> & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const cancelEdit = useRef<(() => void) | null>(null)
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        className="px-safe"
        onEscapeKeyDown={(e) => {
          if (!cancelEdit.current) return
          e.preventDefault()
          cancelEdit.current()
        }}
      >
        {open ? <BriefPanel {...p} variant="drawer" cancelEditRef={cancelEdit} /> : null}
      </DrawerContent>
    </Drawer>
  )
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h3 className="flex items-baseline justify-between gap-2 pb-1.5 text-[11px] font-semibold tracking-wider text-dimmer uppercase">
        {title}
        {aside ? <span className="text-xs font-medium tracking-normal normal-case">{aside}</span> : null}
      </h3>
      {children}
    </section>
  )
}

const rowClass = 'flex min-w-0 items-start gap-2 rounded-md py-1 text-sm'
const linkClass = 'min-w-0 break-words text-primary underline decoration-primary/40 underline-offset-2 [overflow-wrap:anywhere] active:opacity-70'

function ResourceRow({ r, fileLinks }: { r: BriefResource; fileLinks: FileStats }) {
  const Icon = (r.kind && KIND_ICON[r.kind]) || StickyNoteIcon
  const icon = <Icon className="mt-0.5 size-4 shrink-0 text-dimmer" />
  if (r.url) {
    return (
      <li className={rowClass}>
        {icon}
        <a href={r.url} target="_blank" rel="noopener noreferrer" className={linkClass} title={r.url}>
          {r.label || r.url}
        </a>
      </li>
    )
  }
  if (r.kind == null) {
    return (
      <li className={rowClass}>
        {icon}
        <Markdown text={r.text} className="min-w-0 flex-1 text-sm" />
      </li>
    )
  }
  const path = r.path ?? r.label ?? r.text
  const previewable = FILE_KINDS.has(r.kind) && !!r.path && fileLinks.api.isLink(r.path, 'code')
  return (
    <li className={rowClass}>
      {icon}
      {previewable ? (
        <button
          type="button"
          onClick={() => fileLinks.api.open(r.path as string, 'code')}
          title={`Preview ${path}`}
          className="min-w-0 cursor-pointer text-left font-mono text-[13px] break-all text-foreground underline decoration-primary/35 decoration-dotted underline-offset-[3px] outline-none hover:decoration-primary hover:decoration-solid focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
        >
          {path}
        </button>
      ) : (
        <span className="min-w-0 font-mono text-[13px] break-all text-muted-foreground select-all">{path}</span>
      )}
    </li>
  )
}
