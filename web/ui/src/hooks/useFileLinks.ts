import { createContext, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'

import { ApiError, api } from '@/api/client'
import type { FileStat } from '@/api/types'

/** Where a path candidate came from in the markdown: a code span, plain text, a `[t](rel)` link or a `[[wiki]]` link (notes). */
export type FileLinkSource = 'code' | 'text' | 'file' | 'wiki'

/**
 * What <Markdown> asks while rendering: should this candidate be a link, and what a click
 * does. Absent (no provider) → paths render as plain text, exactly as before.
 */
export interface FileLinkApi {
  isLink: (raw: string, source: FileLinkSource) => boolean
  open: (raw: string, source: FileLinkSource) => void
  /** The file preview only: an <img> src for a local image reference, or null. */
  imageSrc?: (src: string) => string | null
}

export const FileLinksContext = createContext<FileLinkApi | null>(null)

/** Words <Markdown> marks in text nodes (the notes explorer, while a search is active). */
export const HighlightContext = createContext<string[]>([])

const BATCH = 200
const DEBOUNCE_MS = 150
/** A path that did not exist is asked about again after this long (the agent may create it). */
const MISS_TTL_MS = 60_000
/** A host whose server has no files API (older version, 404/405/501) is left alone this long. */
const UNSUPPORTED_BACKOFF_MS = 5 * 60_000
const MAX_STORES = 30

/** One session's stat cache: `request()` batches (debounced) `POST …/files/stat`. */
class StatStore {
  entries = new Map<string, { stat: FileStat | null; at: number }>()
  private queued = new Set<string>()
  private inFlight = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private unsupportedUntil = 0
  private version = 0
  private listeners = new Set<() => void>()
  private host: string
  private id: string

  constructor(host: string, id: string) {
    this.host = host
    this.id = id
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  getVersion = () => this.version

  request(paths: string[]) {
    const now = Date.now()
    if (now < this.unsupportedUntil) return
    let added = false
    for (const p of paths) {
      const e = this.entries.get(p)
      if (e && (e.stat?.exists || now - e.at < MISS_TTL_MS)) continue
      if (this.queued.has(p) || this.inFlight.has(p)) continue
      this.queued.add(p)
      added = true
    }
    if (added) this.schedule()
  }

  private schedule() {
    if (!this.timer) this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS)
  }

  private flush() {
    this.timer = null
    const batch = [...this.queued].slice(0, BATCH)
    if (!batch.length) return
    for (const p of batch) {
      this.queued.delete(p)
      this.inFlight.add(p)
    }
    api
      .fileStat(this.host, this.id, batch)
      .then((r) => {
        const now = Date.now()
        const seen = new Set<string>()
        for (const f of r.files ?? []) {
          this.entries.set(f.input, { stat: f, at: now })
          seen.add(f.input)
        }
        for (const p of batch) if (!seen.has(p)) this.entries.set(p, { stat: null, at: now })
        this.version += 1
        for (const fn of this.listeners) fn()
      })
      .catch((err) => {
        if (err instanceof ApiError && [404, 405, 501].includes(err.status)) this.unsupportedUntil = Date.now() + UNSUPPORTED_BACKOFF_MS
      })
      .finally(() => {
        for (const p of batch) this.inFlight.delete(p)
        if (this.queued.size) this.schedule()
      })
  }

  /** An existing regular file, or null. */
  file(raw: string): FileStat | null {
    const s = this.entries.get(raw)?.stat
    return s?.exists && s.isFile ? s : null
  }
}

// Kept across remounts (switching sessions and back reuses the cache).
const stores = new Map<string, StatStore>()

function storeFor(host: string, id: string): StatStore {
  const key = `${host}\u0000${id}`
  let s = stores.get(key)
  if (!s) {
    if (stores.size >= MAX_STORES) stores.delete(stores.keys().next().value as string)
    s = new StatStore(host, id)
    stores.set(key, s)
  }
  return s
}

/**
 * Which paths mentioned in a session's chat exist on its host. `request(paths)` asks the
 * server (batched, cached per session); `api.isLink` is true for existing regular files; a
 * click hands the stat (with its `:line`) to `onOpen`.
 */
export function useFileStats(host: string, id: string, onOpen: (stat: FileStat) => void) {
  const store = useMemo(() => storeFor(host, id), [host, id])
  const version = useSyncExternalStore(store.subscribe, store.getVersion)
  const onOpenRef = useRef(onOpen)
  useEffect(() => {
    onOpenRef.current = onOpen
  }, [onOpen])

  const request = useCallback((paths: string[]) => store.request(paths), [store])
  const linkApi = useMemo<FileLinkApi>(
    () => ({
      // A new object per `version`, so <Markdown> re-renders when stats arrive.
      isLink: (raw) => version >= 0 && store.file(raw) !== null,
      open: (raw) => {
        const s = store.file(raw)
        if (s) onOpenRef.current(s)
      },
    }),
    [store, version],
  )
  return { api: linkApi, request }
}

export type FileStats = ReturnType<typeof useFileStats>
