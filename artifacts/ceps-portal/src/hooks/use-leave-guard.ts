import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Small navigation guard for wouter: intercepts in-app link clicks and the
 * browser Back/Forward button while `active`, and registers the native
 * beforeunload warning only while active.
 */
export function useLeaveGuard(active: boolean, navigate: (to: string) => void, currentUrl: string) {
  const currentUrlRef = useRef(currentUrl);
  currentUrlRef.current = currentUrl;
  const [pending, setPending] = useState<(() => void) | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const bypassRef = useRef(false);
  const skipNextPopRef = useRef(false);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const onClick = (e: MouseEvent) => {
      if (!activeRef.current || bypassRef.current || e.defaultPrevented) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.hasAttribute('download')) return;
      const target = anchor.getAttribute('target');
      if (target && target !== '_self') return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const to = url.pathname + url.search + url.hash;
      if (to === window.location.pathname + window.location.search + window.location.hash) return;
      e.preventDefault();
      e.stopPropagation();
      setPending(() => () => navigateRef.current(to));
    };
    const onPopState = (e: PopStateEvent) => {
      if (skipNextPopRef.current) { skipNextPopRef.current = false; return; }
      if (!activeRef.current || bypassRef.current) return;
      // Capture listener at window runs before wouter's listener; restore the URL.
      e.stopImmediatePropagation();
      window.history.pushState(null, '', currentUrlRef.current);
      setPending(() => () => {
        skipNextPopRef.current = true;
        window.history.back();
      });
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPopState, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPopState, true);
    };
  }, [active]);

  /** Run `action` immediately when clean, otherwise ask first. */
  const guard = useCallback((action: () => void) => {
    if (activeRef.current) setPending(() => action);
    else action();
  }, []);

  /** Leave without asking again (after Discard or a successful save). */
  const proceed = useCallback(() => {
    const action = pending;
    setPending(null);
    if (!action) return;
    bypassRef.current = true;
    action();
    window.setTimeout(() => { bypassRef.current = false; }, 0);
  }, [pending]);

  const cancel = useCallback(() => setPending(null), []);

  return { open: pending !== null, guard, proceed, cancel };
}
