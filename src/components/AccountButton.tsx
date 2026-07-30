import { useState } from 'react';

import { signInWithGoogle, signOut } from '../lib/supabase';
import { sessionLabel, useSession } from '../lib/useSession';

/**
 * Sign in with Google, or sign out.
 *
 * Renders nothing when the deployment has no Supabase credentials, so the static
 * build stays exactly as it was rather than showing a button that cannot work.
 */
export function AccountButton() {
  const { session, ready, available } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (!available) return null;
  if (!ready) return <span className="account account--pending" aria-hidden="true" />;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      // Most likely the Google provider is not enabled on the project yet. Say
      // so in place rather than failing silently.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (session) {
    return (
      <span className="account">
        <span className="account__name" title={session.user.email ?? undefined}>
          {sessionLabel(session)}
        </span>
        <button type="button" className="button button--small" disabled={busy} onClick={() => run(signOut)}>
          Sign out
        </button>
      </span>
    );
  }

  return (
    <span className="account">
      {error && <span className="account__error">{error}</span>}
      <button
        type="button"
        className="button button--small"
        disabled={busy}
        onClick={() => run(signInWithGoogle)}
        title="Sign in to keep your progress across devices"
      >
        {busy ? 'Signing in…' : 'Sign in with Google'}
      </button>
    </span>
  );
}
