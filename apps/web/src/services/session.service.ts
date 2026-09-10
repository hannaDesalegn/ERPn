/**
 * The session endpoints.
 *
 * The only part of the client that is not reading fixtures. Everything here talks to the real
 * API, because identity is the one thing section 16.2 says must never be faked: a convincing
 * simulation of authentication is worse than its absence, since it looks finished.
 *
 * WHAT THIS MODULE NEVER DOES. It does not read or write a token, because there is nothing to
 * read: the session is an HttpOnly cookie the browser attaches to every request and script
 * cannot see. It does not put anything in `localStorage` or `sessionStorage`. And it does not
 * construct a user, a company, a role or a permission from anything but a server response.
 *
 * The shapes below mirror what `/me` returns. They are declared here rather than imported from
 * the existing domain types on purpose: `domain/security.ts` describes the mock identity, which
 * carries a job title and a single role key that the server does not send and this frontend must
 * not invent. Section 3.2 makes the server's response the contract.
 */

import { ApiError, request } from './client';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface SessionCompany {
  id: string;
  name: string;
  isActive: boolean;
}

export interface SessionRole {
  key: string;
  name: string;
}

/** Exactly the `/me` response, and nothing added to it. */
export interface Me {
  user: SessionUser;
  /** Every company this person may enter. The server computes it from their memberships. */
  companies: SessionCompany[];
  /** Null until a company is entered. Permissions are a question about a company. */
  activeCompany: { id: string; name: string } | null;
  roles: SessionRole[];
  /**
   * Effective permissions in the active company.
   *
   * Typed as strings rather than as the frontend's `Permission` union, deliberately. The server
   * is the authority on what exists; treating its response as the union would mean a release
   * that adds a capability produces a value this type says is impossible. `can()` narrows at the
   * call site instead, where a typo is what actually needs catching.
   */
  permissions: string[];
}

export const sessionApi = {
  /**
   * The current session, or null when there is none.
   *
   * A 401 is an answer rather than a failure: it means nobody is signed in, which is an ordinary
   * state on first load. Every other status is a real error and is rethrown, so a server that is
   * down does not quietly present itself as a signed-out user.
   */
  async me(): Promise<Me | null> {
    try {
      return await request<Me>('/me');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },

  /**
   * Signs in.
   *
   * Returns nothing, because the response carries nothing: the server answers 204 and sets the
   * cookie. The caller learns who it is by asking `/me`, which computes the answer rather than
   * echoing what was just sent.
   */
  async signIn(email: string, password: string): Promise<void> {
    await request<void>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  /** Ends the session server side. The cookie is cleared by the server's response. */
  async signOut(): Promise<void> {
    await request<void>('/auth/logout', { method: 'POST' });
  },

  /**
   * Enters a company.
   *
   * Sends only the company identifier, which the server checks against that person's
   * memberships before honouring. The refreshed `/me` view comes back from the server rather
   * than being assembled here from what was requested, so a switch the server refused cannot
   * leave the interface showing a company nobody entered.
   */
  switchCompany(companyId: string): Promise<Me> {
    return request<Me>('/me/company', {
      method: 'POST',
      body: JSON.stringify({ companyId }),
    });
  },
};
