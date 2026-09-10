/**
 * What renders before the application does.
 *
 * The gate is the frontend half of "unauthenticated requests cannot reach protected operations".
 * It is not the enforcing half. The server refuses every request without a live session and a
 * company, and would go on refusing them if this file were deleted. What the gate adds is that a
 * signed-out browser never renders application chrome, never issues the requests that would be
 * refused, and never shows a screen half-populated with errors instead of a sign-in form.
 *
 * FOUR STATES, ALL EXHAUSTIVE. Loading, error, signed out, and signed in. There is deliberately
 * no fifth branch that renders the application anyway, and no default that falls through to it.
 * A gate whose unknown state renders the app is a gate in name only.
 *
 * SIGNED IN IS NOT ENOUGH. A session with no company entered cannot be authorized for anything,
 * because every permission is a question about a company. So that state gets its own screen
 * rather than being folded into either neighbour.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useSessionState } from './session';

export function SessionGate({ children }: { children: ReactNode }) {
  const { state } = useSessionState();

  switch (state.status) {
    case 'loading':
      return <FullScreen>Loading</FullScreen>;

    case 'error':
      // Not treated as signed out. A server that cannot be reached is a different problem from
      // a session that has ended, and showing a sign-in form here invites someone to type a
      // password at a server that is not answering.
      return <ServerUnreachable message={state.message} />;

    case 'unauthenticated':
      return <SignInScreen />;

    case 'authenticated':
      return state.me.activeCompany ? <>{children}</> : <ChooseCompanyScreen />;
  }
}

// ---------------------------------------------------------------------------

function FullScreen({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center bg-canvas p-6 text-sm text-secondary">
      {children}
    </div>
  );
}

function ServerUnreachable({ message }: { message: string }) {
  const { refresh } = useSessionState();

  return (
    <FullScreen>
      <div className="w-full max-w-sm space-y-3 text-center">
        <p className="text-sm font-medium text-primary">Cannot reach the server</p>
        <p className="text-xs text-muted">{message}</p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent"
        >
          Try again
        </button>
      </div>
    </FullScreen>
  );
}

// ---------------------------------------------------------------------------

/**
 * The sign-in form.
 *
 * It sends an email and a password and keeps neither. There is no "remember me", nothing is
 * written to storage, and the password lives in component state for exactly as long as the form
 * is mounted. The server answers with a cookie the browser holds and script cannot read.
 *
 * One message for every failure, matching what the server returns. Telling a caller that the
 * address exists but the password is wrong is the same disclosure whether it comes from the API
 * or from the interface in front of it.
 */
function SignInScreen() {
  const { signIn } = useSessionState();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await signIn(email, password);
    } catch {
      setError('That email and password do not match an account.');
    } finally {
      // Cleared whether it succeeded or failed. On success the component is about to unmount and
      // on failure there is no reason to keep it in memory for the next attempt.
      setPassword('');
      setBusy(false);
    }
  };

  return (
    <div className="grid h-full place-items-center bg-canvas p-6">
      <form
        onSubmit={(event) => void onSubmit(event)}
        className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-surface p-6"
        aria-labelledby="sign-in-heading"
      >
        <h1 id="sign-in-heading" className="text-base font-semibold text-primary">
          Sign in
        </h1>

        <div className="space-y-1">
          <label htmlFor="email" className="block text-xs font-medium text-secondary">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-sm text-primary"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="password" className="block text-xs font-medium text-secondary">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-sm text-primary"
          />
        </div>

        {error && (
          <p role="alert" className="text-xs text-danger-text">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-60"
        >
          {busy ? 'Signing in' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Choosing which company to work in.
 *
 * The list comes from `/me`, which computes it from that person's memberships. Nothing here can
 * offer a company they do not belong to, and the server checks membership again when the choice
 * is made, so this screen is a convenience over a decision the server owns.
 *
 * With exactly one company the choice is made automatically, once. That is not the frontend
 * deciding anything: it sends the same request the button would send and the server validates it
 * the same way. A person who belongs to one company should not have to click through a menu of
 * one on every sign-in.
 */
function ChooseCompanyScreen() {
  const { state, switchCompany, signOut } = useSessionState();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Guards the automatic entry, so a refusal shows the list instead of retrying forever.
  const attempted = useRef(false);

  const companies = state.status === 'authenticated' ? state.me.companies : [];
  const only = companies.length === 1 ? companies[0] : undefined;

  const enter = async (companyId: string) => {
    setBusy(true);
    setError(null);
    try {
      await switchCompany(companyId);
    } catch {
      setError('That company could not be opened. Ask an administrator to check your access.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!only || attempted.current) return;
    attempted.current = true;
    void enter(only.id);
    // `enter` is stable enough for this one-shot effect and re-running on its identity would
    // defeat the guard above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [only]);

  if (companies.length === 0) {
    return (
      <FullScreen>
        <div className="w-full max-w-sm space-y-3 text-center">
          <p className="text-sm font-medium text-primary">No company access</p>
          <p className="text-xs text-muted">
            Your account is not a member of any company. An administrator has to add you before
            you can work.
          </p>
          <button
            type="button"
            onClick={() => void signOut()}
            className="rounded-md border border-line px-3 py-1.5 text-xs font-medium text-secondary"
          >
            Sign out
          </button>
        </div>
      </FullScreen>
    );
  }

  return (
    <div className="grid h-full place-items-center bg-canvas p-6">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-surface p-6">
        <h1 className="text-base font-semibold text-primary">Choose a company</h1>

        <ul className="space-y-2">
          {companies.map((company) => (
            <li key={company.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void enter(company.id)}
                className="w-full rounded-md border border-line px-3 py-2 text-left text-sm text-primary hover:bg-hover disabled:opacity-60"
              >
                {company.name}
              </button>
            </li>
          ))}
        </ul>

        {error && (
          <p role="alert" className="text-xs text-danger-text">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
