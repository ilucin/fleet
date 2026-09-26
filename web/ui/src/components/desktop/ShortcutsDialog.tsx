import { Fragment } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { SHORTCUT_HELP } from '@/lib/shortcuts'

/** `?`: every desktop shortcut, from the same table the key handler documents. */
export function ShortcutsDialog({ open, onOpenChange, modKey }: { open: boolean; onOpenChange: (o: boolean) => void; modKey: string }) {
  const label = (k: string) => (k === 'mod' ? modKey : k)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Single keys work whenever you are not typing in a field; Esc leaves a field.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {SHORTCUT_HELP.map((section) => (
            <section key={section.title}>
              <h3 className="pb-1.5 text-[11px] font-semibold tracking-wider text-dimmer uppercase">{section.title}</h3>
              <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5">
                {section.items.map((item) => (
                  <Fragment key={item.label}>
                    <dt className="flex items-center gap-1 whitespace-nowrap">
                      {item.keys.map((combo, i) => (
                        <Fragment key={i}>
                          {i > 0 ? <span className="text-[11px] text-dimmer">or</span> : null}
                          <KbdGroup>
                            {combo.map((k, j) => (
                              <Kbd key={j} className="border border-border">
                                {label(k)}
                              </Kbd>
                            ))}
                          </KbdGroup>
                        </Fragment>
                      ))}
                    </dt>
                    <dd className="text-sm text-muted-foreground">{item.label.replace('mod+', `${modKey}+`)}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
