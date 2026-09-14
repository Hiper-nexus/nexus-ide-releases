import { useEffect, useState } from 'react';

/**
 * Re-render trigger for time-derived labels (quota reset countdowns). One
 * shared 60s tick per mounted consumer keeps "4h32m" actually counting down
 * between provider refreshes instead of freezing at fetch time.
 */
export function useMinuteTick(): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setTick(Date.now());
    }, 60_000);
    return () => clearInterval(timer);
  }, []);
  return tick;
}
