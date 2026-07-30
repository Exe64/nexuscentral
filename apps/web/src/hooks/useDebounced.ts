import { useEffect, useState } from 'react';

/**
 * The value, held back until it has stopped changing for `delayMs`.
 *
 * The live rule test runs server-side against 300 items; firing it on every
 * keystroke would send a request per character, most of them for patterns that are
 * still half-typed.
 */
export function useDebounced<T>(value: T, delayMs = 400): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
