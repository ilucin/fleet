import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'

import { cn } from '@/lib/utils'

const coarsePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

export interface InlineEditProps {
  value: string
  editing: boolean
  /** Clicking the text starts editing. Absent: plain text. */
  onEdit?: () => void
  /** Enter or clicking away, with the trimmed text (the caller decides whether it changed). */
  onCommit: (text: string) => void
  /** Esc. */
  onCancel: () => void
  /** Text style (size, weight) — shared by the text and the field, so switching never moves anything. */
  className?: string
  /** The field's aria-label. */
  label: string
  /** Tooltip on the clickable text. */
  hint?: string
  maxLength?: number
  /**
   * On a touch screen, does a tap on the text edit? `false` inside a row / card: the tap opens
   * it (long-press edits there), as a tap anywhere else on it does.
   */
  tapToEdit?: boolean
}

/**
 * The app's one inline editor: click the text to edit it in place, Enter or clicking away
 * saves, Esc cancels. No edit buttons; the field takes exactly the text's box (see
 * InlineField), so the layout never jumps.
 */
export function InlineEdit({ value, editing, onEdit, onCommit, onCancel, className, label, hint, maxLength, tapToEdit = true }: InlineEditProps) {
  if (editing) return <InlineField initial={value} onCommit={onCommit} onCancel={onCancel} className={className} label={label} maxLength={maxLength} />
  if (!onEdit) {
    return (
      <span title={value} className={cn('min-w-0 truncate', className)}>
        {value}
      </span>
    )
  }
  return (
    <button
      type="button"
      title={hint ?? value}
      onClick={(e) => {
        // In a row / card on a touch screen: let the tap open it.
        if (!tapToEdit && coarsePointer()) return
        e.preventDefault()
        e.stopPropagation()
        onEdit()
      }}
      className={cn(
        'min-w-0 cursor-text truncate rounded-sm text-left outline-none',
        'hover:underline hover:decoration-dotted hover:underline-offset-4 focus-visible:ring-3 focus-visible:ring-ring/50',
        className,
      )}
    >
      {value}
    </button>
  )
}

export interface InlineFieldProps {
  initial?: string
  placeholder?: string
  onCommit: (text: string) => void
  onCancel: () => void
  className?: string
  label: string
  maxLength?: number
}

/**
 * The editing half of InlineEdit, also usable on its own (a name typed into an empty spot).
 * An invisible copy of the text sets the box — the same font, so the same line height as the
 * text it replaces — and the input is laid over it; its ring is a box-shadow, outside the flow.
 */
export function InlineField({ initial = '', placeholder, onCommit, onCancel, className, label, maxLength }: InlineFieldProps) {
  const [text, setText] = useState(initial)
  const done = useRef(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.select(), [])

  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    if (commit) onCommit(text.trim())
    else onCancel()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
    }
  }
  // Inside a row / card link: clicking in the field must not open it.
  const swallow = (e: MouseEvent | PointerEvent) => {
    e.stopPropagation()
    if (e.type === 'click') e.preventDefault()
  }

  return (
    <span className={cn('relative min-w-0 flex-1', className)} onClick={swallow} onPointerDown={swallow}>
      <span aria-hidden className="invisible block truncate whitespace-pre">
        {text || placeholder || ' '}
      </span>
      <input
        // Focused in the same commit as the gesture that opened it (see openTitleEditor).
        autoFocus
        ref={ref}
        value={text}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-label={label}
        enterKeyHint="done"
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => finish(true)}
        className={cn(
          'absolute inset-y-0 -inset-x-1 min-w-0 rounded-sm bg-background px-1 outline-none ring-2 ring-ring/50',
          'placeholder:font-normal placeholder:text-dimmer',
          // The label's size (base styles lift inputs to 16px); touch screens keep 16px, or iOS zooms.
          'pointer-fine:text-[length:inherit]',
        )}
      />
    </span>
  )
}
