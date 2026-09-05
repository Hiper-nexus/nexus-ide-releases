import { useCallback, useEffect, useRef, useState } from 'react';

/** Local catalog reads keep valid data and ignore older or unmounted requests. */
export function useCatalogResource<T>(read: () => Promise<T>, failureMessage: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const sequence = useRef(0);

  const reload = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const next = await read();
      if (mounted.current && request === sequence.current) setData(next);
    } catch {
      if (mounted.current && request === sequence.current) setError(failureMessage);
    } finally {
      if (mounted.current && request === sequence.current) setLoading(false);
    }
  }, [read, failureMessage]);

  const accept = useCallback((next: T) => {
    if (!mounted.current) return;
    sequence.current += 1;
    setData(next);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => { mounted.current = false; sequence.current += 1; };
  }, [reload]);

  return { data, loading, error, reload, accept };
}
