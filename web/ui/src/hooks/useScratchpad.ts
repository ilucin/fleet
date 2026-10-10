import { useSyncExternalStore } from 'react'

import { scratchpad } from '@/lib/scratchpad'

/** Is the scratchpad open (any screen can toggle it: lib/scratchpad's store). */
export const useScratchpadOpen = () => useSyncExternalStore(scratchpad.subscribe, scratchpad.isOpen, () => false)
