import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiClientError,
  ApiUnreachableError,
  REASON_TEXT,
  SessionUser,
  api,
  setCsrfToken,
} from '../lib/api';
import { Capabilities, resolveCapabilities } from '../config/capabilities';
import { runtimeEnvironment } from '../config/runtime';

export type SessionStatus = 'checking' | 'signed-out' | 'signed-in';

export interface BootstrapState {
  required: boolean;
  tokenRequired: boolean;
}

export interface UseSessionResult {
  status: SessionStatus;
  user: SessionUser | null;
  capabilities: Capabilities;
  bootstrap: BootstrapState;
  /** True when the API answered the health probe. */
  apiReachable: boolean;
  error: string | null;
  /** Re-probes the API; used after sign-in, sign-out and failures. */
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  bootstrapAdministrator: (input: {
    email: string;
    name: string;
    password: string;
    token?: string;
  }) => Promise<void>;
  acceptInvitation: (input: { token: string; name: string; password: string }) => Promise<void>;
}

const UNKNOWN_BOOTSTRAP: BootstrapState = { required: false, tokenRequired: false };

/**
 * Owns the authenticated session and the capability report.
 *
 * The health probe is what makes capability reporting honest: until the API answers, every
 * server-side capability is reported as unavailable rather than assumed.
 */
export function useSession(): UseSessionResult {
  const [status, setStatus] = useState<SessionStatus>('checking');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [apiReachable, setApiReachable] = useState(false);
  const [apiCapabilities, setApiCapabilities] = useState({
    authentication: false,
    administration: false,
    durableStorage: false,
    generation: false,
  });
  const [bootstrap, setBootstrap] = useState<BootstrapState>(UNKNOWN_BOOTSTRAP);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);

    // Demo mode is a self-contained local simulation and never talks to the API.
    if (runtimeEnvironment.demoMode) {
      setStatus('signed-out');
      return;
    }

    try {
      const health = await api.health();
      setApiReachable(true);
      setApiCapabilities(health.capabilities);
      setBootstrap({
        required: health.bootstrap.required,
        tokenRequired: health.bootstrap.tokenRequired,
      });
    } catch {
      setApiReachable(false);
      setStatus('signed-out');
      return;
    }

    try {
      const me = await api.me();
      setCsrfToken(me.csrfToken);
      setUser(me.user);
      setStatus('signed-in');
    } catch (cause) {
      setCsrfToken(null);
      setUser(null);
      setStatus('signed-out');
      if (!(cause instanceof ApiClientError) || cause.status !== 401) {
        setError(cause instanceof Error ? cause.message : 'Could not check the current session.');
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const afterAuthenticated = useCallback(async (csrfToken: string, nextUser: SessionUser) => {
    setCsrfToken(csrfToken);
    setUser(nextUser);
    setApiReachable(true);
    setStatus('signed-in');
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      setError(null);
      const response = await api.login({ email, password });
      await afterAuthenticated(response.csrfToken, response.user);
    },
    [afterAuthenticated]
  );

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch (cause) {
      // A failed logout still clears local state; the cookie is dropped by the server on the
      // next successful call, and leaving the UI signed in would be worse.
      if (!(cause instanceof ApiUnreachableError)) {
        setError(cause instanceof Error ? cause.message : null);
      }
    }
    setCsrfToken(null);
    setUser(null);
    setStatus('signed-out');
    await refresh();
  }, [refresh]);

  const bootstrapAdministrator = useCallback(
    async (input: { email: string; name: string; password: string; token?: string }) => {
      setError(null);
      const response = await api.bootstrap(input);
      await afterAuthenticated(response.csrfToken, response.user);
    },
    [afterAuthenticated]
  );

  const acceptInvitation = useCallback(
    async (input: { token: string; name: string; password: string }) => {
      setError(null);
      const response = await api.acceptInvitation(input);
      await afterAuthenticated(response.csrfToken, response.user);
    },
    [afterAuthenticated]
  );

  const capabilities = useMemo(
    () =>
      resolveCapabilities({
        demoMode: runtimeEnvironment.demoMode,
        api: apiReachable
          ? {
              reachable: true,
              capabilities: apiCapabilities,
              bootstrapRequired: bootstrap.required,
              tokenRequired: bootstrap.tokenRequired,
            }
          : null,
      }),
    [apiReachable, apiCapabilities, bootstrap]
  );

  return {
    status,
    user,
    capabilities,
    bootstrap,
    apiReachable,
    error,
    refresh,
    signIn,
    signOut,
    bootstrapAdministrator,
    acceptInvitation,
  };
}

/** Maps an API failure to wording a person can act on. */
export function describeAuthFailure(cause: unknown): string {
  if (cause instanceof ApiUnreachableError) {
    return 'The JevDeck API did not respond. Check that it is running and reachable.';
  }
  if (cause instanceof ApiClientError) {
    if (cause.code === 'rate_limited') {
      const retryAfter = (cause.details as { retryAfterSeconds?: number } | undefined)
        ?.retryAfterSeconds;
      return retryAfter
        ? `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`
        : 'Too many failed attempts. Try again shortly.';
    }
    return cause.message;
  }
  return cause instanceof Error ? cause.message : 'Something went wrong.';
}

export { REASON_TEXT };
