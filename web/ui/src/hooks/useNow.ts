import { useEffect, useState } from 'react'

/** Current time, re-rendering every `ms` — keeps "updated 5s ago" honest without refetching. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}
