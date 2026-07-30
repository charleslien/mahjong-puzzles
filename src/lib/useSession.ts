/**
 * Current auth session, or null when signed out or unconfigured.
 *
 * Signing in is strictly additive here. Progress has always lived in
 * localStorage and still does, so the site works exactly as before for a signed-
 * out visitor and for a clone with no credentials. An account adds a durable,
 * server-verified record on top; it is not a precondition for using anything.
 */

import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';

import { currentSession, isConfigured, mayHaveSession, onAuthChange } from './supabase';

export interface SessionState {
  session: Session | null;
  /** False until the first session lookup resolves, so the UI can avoid flicker. */
  ready: boolean;
  /** Whether sign-in is available at all in this deployment. */
  available: boolean;
}

export function useSession(): SessionState {
  const available = isConfigured();
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!available);

  useEffect(() => {
    if (!available) return;
    // No stored token means definitely signed out, and confirming that through
    // the library would download it for nothing. Signing in loads it on demand.
    if (!mayHaveSession()) {
      setReady(true);
      return;
    }
    let live = true;

    currentSession()
      .then((found) => {
        if (!live) return;
        setSession(found);
        setReady(true);
      })
      .catch(() => {
        // A failed session lookup must not block the page; it just means signed
        // out as far as the UI is concerned.
        if (live) setReady(true);
      });

    const unsubscribe = onAuthChange((next) => {
      if (live) setSession(next);
    });

    return () => {
      live = false;
      unsubscribe();
    };
  }, [available]);

  return { session, ready, available };
}

/** A short label for the signed-in user. */
export function sessionLabel(session: Session): string {
  const meta = session.user.user_metadata ?? {};
  const name = (meta.full_name ?? meta.name) as string | undefined;
  if (name) return name.split(' ')[0];
  const email = session.user.email;
  return email ? email.split('@')[0] : 'signed in';
}
