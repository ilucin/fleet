import { Fragment, memo, type ReactNode } from 'react'

import { linkify, parseMarkdown, type Block, type Inline } from '@/lib/markdown'
import { cn } from '@/lib/utils'

// Renders the lib/markdown.ts AST as React elements: text is always a React text child
// (escaped), links are only the http(s) hrefs the parser let through. No innerHTML.

const linkClass =
  'text-primary underline decoration-primary/40 underline-offset-2 break-all active:opacity-70 [overflow-wrap:anywhere]'

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>
      {children}
    </a>
  )
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return <Fragment key={i}>{n.v}</Fragment>
      case 'code':
        return (
          <code key={i} className="rounded-[5px] bg-foreground/[0.07] px-1 py-px font-mono text-[0.86em] [overflow-wrap:anywhere]">
            {n.v}
          </code>
        )
      case 'strong':
        return (
          <strong key={i} className="font-semibold text-foreground">
            <Inlines nodes={n.children} />
          </strong>
        )
      case 'em':
        return (
          <em key={i}>
            <Inlines nodes={n.children} />
          </em>
        )
      case 'link':
        return (
          <Link key={i} href={n.href}>
            <Inlines nodes={n.children} />
          </Link>
        )
    }
  })
}

function Lines({ lines }: { lines: Inline[][] }) {
  return lines.map((l, i) => (
    <Fragment key={i}>
      {i > 0 ? <br /> : null}
      <Inlines nodes={l} />
    </Fragment>
  ))
}

const HEADING = { 1: 'text-[1.14em]', 2: 'text-[1.07em]', 3: 'text-[1em] text-muted-foreground' } as const

function BlockView({ b }: { b: Block }) {
  switch (b.t) {
    case 'p':
      return (
        <p>
          <Lines lines={b.lines} />
        </p>
      )
    case 'h':
      return (
        <div className={cn('mt-3 mb-1 leading-snug font-bold first:mt-0', HEADING[b.level])}>
          <Inlines nodes={b.content} />
        </div>
      )
    case 'hr':
      return <hr className="my-3 border-border" />
    case 'quote':
      return (
        <blockquote className="border-l-3 border-border pl-2.5 text-muted-foreground">
          <Lines lines={b.lines} />
        </blockquote>
      )
    case 'list': {
      const List = b.ordered ? 'ol' : 'ul'
      return (
        <List className={cn('space-y-0.5 pl-5', b.ordered ? 'list-decimal' : 'list-disc', 'marker:text-dimmer')}>
          {b.items.map((it, i) => {
            const Sub = it.sub?.ordered ? 'ol' : 'ul'
            return (
              <li key={i}>
                <Inlines nodes={it.content} />
                {it.sub ? (
                  <Sub className={cn('mt-0.5 space-y-0.5 pl-5', it.sub.ordered ? 'list-decimal' : 'list-[circle]')}>
                    {it.sub.items.map((s, j) => (
                      <li key={j}>
                        <Inlines nodes={s} />
                      </li>
                    ))}
                  </Sub>
                ) : null}
              </li>
            )
          })}
        </List>
      )
    }
    case 'table':
      return (
        <div className="no-scrollbar -mx-0.5 overflow-x-auto">
          <table className="border-collapse text-[0.88em]">
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i} className="border border-border bg-muted px-2 py-1 text-left font-semibold whitespace-nowrap">
                    <Inlines nodes={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className="border border-border px-2 py-1 whitespace-nowrap">
                      <Inlines nodes={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'code':
      return (
        <pre className="overflow-x-auto rounded-lg border border-border/60 bg-background/60 px-2.5 py-2 font-mono text-[0.84em] leading-relaxed">
          <code data-lang={b.lang || undefined}>{b.text}</code>
        </pre>
      )
  }
}

/** Claude's markdown, rendered safely. Memoised: a poll that returns the same text re-renders nothing. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text)
  return (
    <div className={cn('space-y-2 [overflow-wrap:anywhere]', className)}>
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} />
      ))}
    </div>
  )
})

/** Plain text with bare http(s) URLs as links — the terminal view. */
export const Linkified = memo(function Linkified({ text }: { text: string }) {
  return linkify(text).map((n, i) =>
    n.t === 'link' ? (
      <Link key={i} href={n.href}>
        {n.href}
      </Link>
    ) : n.t === 'text' ? (
      <Fragment key={i}>{n.v}</Fragment>
    ) : null,
  )
})
