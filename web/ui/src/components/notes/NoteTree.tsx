import { ChevronRightIcon, FileTextIcon, FolderIcon, FolderOpenIcon, ImageIcon, LockIcon, FileCodeIcon } from 'lucide-react'

import type { NoteEntry } from '@/api/types'
import { notesHref, type TreeDir } from '@/lib/notes'
import { basename } from '@/lib/paths'
import { cn } from '@/lib/utils'

export interface NoteTreeProps {
  host: string
  root: TreeDir
  open: Set<string>
  onToggle: (dir: string) => void
  selected: string | null
  /** Desktop: compact rows. Mobile (default): ≥ 44px tap targets. */
  compact?: boolean
}

const fileName = (f: NoteEntry) => (f.kind === 'markdown' ? basename(f.path).replace(/\.[^.]+$/, '') : basename(f.path))

/** Folders (collapsible) then files; a file is a link to `#/notes/<host>/<path>`. */
export function NoteTree({ host, root, open, onToggle, selected, compact = false }: NoteTreeProps) {
  return (
    <ul role="tree" aria-label="Notes" className="py-1">
      <Level host={host} dir={root} depth={0} open={open} onToggle={onToggle} selected={selected} compact={compact} />
    </ul>
  )
}

function Level({ host, dir, depth, open, onToggle, selected, compact }: Omit<NoteTreeProps, 'root'> & { dir: TreeDir; depth: number }) {
  const row = cn('flex w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50', compact ? 'h-7 text-[0.8125rem]' : 'min-h-11 text-[0.9375rem]')
  const pad = (d: number) => ({ paddingLeft: `${0.5 + d * (compact ? 0.875 : 1)}rem` })
  return (
    <>
      {dir.dirs.map((d) => {
        const isOpen = open.has(d.path)
        return (
          <li key={d.path} role="treeitem" aria-expanded={isOpen}>
            <button type="button" className={cn(row, 'text-foreground hover:bg-muted/60')} style={pad(depth)} onClick={() => onToggle(d.path)}>
              <ChevronRightIcon className={cn('size-3.5 shrink-0 text-dimmer transition-transform', isOpen && 'rotate-90')} />
              {isOpen ? <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" /> : <FolderIcon className="size-4 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
              <span className="shrink-0 text-[0.6875rem] text-dimmer tabular-nums">{d.count}</span>
            </button>
            {isOpen ? (
              <ul role="group">
                <Level host={host} dir={d} depth={depth + 1} open={open} onToggle={onToggle} selected={selected} compact={compact} />
              </ul>
            ) : null}
          </li>
        )
      })}
      {dir.files.map((f) => {
        const active = f.path === selected
        const Icon = f.encrypted ? LockIcon : f.kind === 'image' ? ImageIcon : f.kind === 'text' ? FileCodeIcon : FileTextIcon
        return (
          <li key={f.path} role="treeitem" aria-selected={active}>
            <a
              href={`#${notesHref(host, f.path)}`}
              title={f.title && f.title !== fileName(f) ? `${f.title} — ${f.path}` : f.path}
              data-note-path={f.path}
              aria-current={active ? 'page' : undefined}
              className={cn(row, active ? 'bg-primary/12 font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground')}
              style={pad(depth)}
            >
              <span className="size-3.5 shrink-0" />
              <Icon className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-dimmer')} />
              <span className="min-w-0 flex-1 truncate">{fileName(f)}</span>
            </a>
          </li>
        )
      })}
    </>
  )
}
