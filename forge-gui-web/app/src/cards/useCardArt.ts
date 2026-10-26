/** React access to the art loader: re-renders when a key's art becomes ready (or art is toggled). */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { cardArt, type ArtLoader } from './art';

export function useCardArt(key: string | undefined, loader: ArtLoader = cardArt): ImageBitmap | null {
  const subscribe = useCallback(
    (notify: () => void) =>
      loader.subscribe((k) => {
        if (k === null || k === key) notify();
      }),
    [loader, key],
  );
  const bitmap = useSyncExternalStore(subscribe, () => loader.peek(key));
  const enabled = loader.enabled;
  useEffect(() => {
    // Ask for it outside render (get() may start a request).
    if (key && enabled) loader.get(key);
  }, [key, loader, enabled]);
  return bitmap;
}
