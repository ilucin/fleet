import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { CheckIcon, Loader2Icon, PencilIcon, XIcon } from 'lucide-react'

import type { Session } from '@/api/types'
import { Button } from '@/components/ui/button'
import { openTitleEditor, stopEditing, useEditing, useRename, useSessionTitle, type TitleScope } from '@/hooks/useTitles'
import { sessionKey } from '@/lib/shortcuts'
import { MAX_TITLE, titleChanged } from '@/lib/title'
import { cn } from '@/lib/utils'

export interface EditableTitleProps {
  session: Session | null
  scope: TitleScope
  /** When there is no session object yet (a pane opened before the fleet loaded). */
  fallbackKey?: string
  /** Text style of the title (size, weight). */
  className?: string
  /**
   * `click`: clicking the title opens the editor (the session header).
   * `pencil`: a pencil button on hover / focus opens it, the title itself stays a link (rows, cards).
   */
  trigger?: 'click' | 'pencil'
}

/**
 * A session's one title (`sessionTitle`), editable in place: Enter / ✓ saves, Esc / ✕ /
 * clicking away cancels. Saving is optimistic (hooks/useTitles.ts) and rolls back with a
 * toast when the session is busy or the rename fails.
 */
export function EditableTitle({ session, scope, fallbackKey, className, trigger = 'pencil' }: EditableTitleProps) {
  const key = session ? sessionKey(session) : (fallbackKey ?? '')
  const { title, saving } = useSessionTitle(session, fallbackKey)
  const editing = useEditing(scope, key) && !!session
  const canEdit = !!session

  if (editing && session) return <TitleInput session={session} initial={title} className={className} />

  const open = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (canEdit) openTitleEditor(scope, key)
  }

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      {trigger === 'click' && canEdit ? (
        <button
          type="button"
          onClick={open}
          title="Rename (e)"
          className={cn('min-w-0 cursor-text truncate rounded-sm text-left outline-none hover:underline hover:decoration-dotted hover:underline-offset-4 focus-visible:ring-3 focus-visible:ring-ring/50', saving && 'opacity-70', className)}
        >
          {title}
        </button>
      ) : (
        <span title={title} className={cn('min-w-0 truncate', saving && 'opacity-70', className)}>
          {title}
        </span>
      )}
      {saving ? <Loader2Icon aria-label="Saving" className="size-3 shrink-0 animate-spin text-dimmer" /> : null}
      {trigger === 'pencil' && canEdit && !saving ? (
        <button
          type="button"
          aria-label="Rename"
          title="Rename"
          onClick={open}
          onPointerDown={(e) => e.stopPropagation()}
          className={cn(
            // Takes no room until the row is hovered or focused, so titles keep their width.
            'hidden size-6 shrink-0 items-center justify-center rounded-md text-dimmer outline-none',
            'group-hover/row:inline-flex group-focus-visible/row:inline-flex hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
            'pointer-coarse:hidden',
          )}
        >
          <PencilIcon className="size-3.5" />
        </button>
      ) : null}
    </span>
  )
}

function TitleInput({ session, initial, className }: { session: Session; initial: string; className?: string }) {
  const rename = useRename()
  const [value, setValue] = useState(initial)
  // A pointerdown on ✓ / ✕ blurs the input before their click lands; don't cancel on that blur.
  const acting = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.select(), [])

  const commit = () => {
    stopEditing()
    if (titleChanged(value, initial)) void rename(session, value)
  }
  const cancel = () => stopEditing()

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }
  const swallow = (e: MouseEvent | PointerEvent) => {
    // Inside a row link: clicking in the field must not open the session. A button's
    // click is its own (✓ submits the form), so only the field's default is cancelled.
    e.stopPropagation()
    if (e.type === 'click' && !(e.target as HTMLElement).closest('button')) e.preventDefault()
  }
  const hold = () => {
    acting.current = true
  }

  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault()
        commit()
      }}
      onClick={swallow}
      onPointerDown={swallow}
    >
      <input
        // Focused in the same commit as the gesture that opened it (see openTitleEditor).
        autoFocus
        ref={inputRef}
        value={value}
        maxLength={MAX_TITLE}
        enterKeyHint="done"
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        aria-label="Session title"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (acting.current) {
            acting.current = false
            return
          }
          cancel()
        }}
        className={cn(
          'h-7 min-w-0 flex-1 rounded-md border border-ring bg-background px-1.5 outline-none ring-3 ring-ring/30',
          className,
        )}
      />
      <Button type="submit" size="icon-sm" variant="ghost" aria-label="Save title" onPointerDown={hold} className="shrink-0">
        <CheckIcon />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Cancel rename"
        onPointerDown={hold}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          cancel()
        }}
        className="shrink-0"
      >
        <XIcon />
      </Button>
    </form>
  )
}
