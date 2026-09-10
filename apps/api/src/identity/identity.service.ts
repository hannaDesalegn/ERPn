/**
 * Identity and company context.
 *
 * Authentication answered who someone is. This answers where they are working, which contract
 * section 5.4 keeps as a separate question, and it is the last question before authorization.
 * Nothing here decides what anyone may do.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE, from section 2.5: the active company is held in the
 * server side session and is never read from a request body, query parameter, path segment,
 * header or frontend state. A company identifier does arrive from the client, once, when someone
 * asks to switch. It is a request, not an authority: it selects among the memberships that
 * person already has, and if it names anything else the answer is the same as for a company that
 * does not exist.
 *
 * WHY THE TENANT IS NEVER STORED ON THE SESSION. It is derived from the membership on every
 * request instead. A tenant cached beside the company would outlive the membership that
 * justified it, and the whole point of re-deriving is that access ends when membership ends.
 */

import { Injectable } from '@nestjs/common';

import {
  actorScope,
  principalScope,
  systemScope,
  UnitOfWork,
  type MembershipRecord,
} from '../database/index.js';
import { AuthorizationService, NO_GRANTS } from '../authorization/authorization.service.js';

/** Who is asking, taken from a validated session and nothing else. */
export interface AuthenticatedPrincipal {
  sessionId: string;
  userId: string;
  /** What the session claims. Checked against a membership before it becomes context. */
  activeCompanyId: string | null;
}

/**
 * A company context that has been verified against a live membership.
 *
 * There is no way to construct one of these from request data, and that is deliberate. Every
 * value in it came from a membership row read under the asking person's own identity.
 */
export interface CompanyContext {
  tenantId: string;
  companyId: string;
  membershipId: string;
}

export interface MeView {
  user: { id: string; email: string; name: string };
  /** Every company this person may enter. Computed from their memberships, never from input. */
  companies: { id: string; name: string; isActive: boolean }[];
  activeCompany: { id: string; name: string } | null;
  /**
   * Roles held in the active company, and empty when there is no active company.
   *
   * Section 2.7 makes roles per company, so this list changes when the company changes and
   * confers nothing outside it.
   */
  roles: { key: string; name: string }[];
  /**
   * Effective permissions in the active company, computed server side.
   *
   * Section 6.2: returned for display purposes only. The client never sends its own permissions
   * and the server never reads one from a request. Every enforcement decision is made again from
   * the database on the request that needs it, so a client that edits this list changes what its
   * own interface renders and nothing about what it may do.
   */
  permissions: string[];
}

export type SwitchCompanyResult =
  | { outcome: 'switched'; context: CompanyContext }
  /**
   * Indistinguishable on purpose.
   *
   * Section 6.1 and criterion 15: a company in another tenant, a company the person is not a
   * member of, and a company that does not exist all produce this. Anything else turns the
   * switch endpoint into an oracle for which company identifiers are real.
   */
  | { outcome: 'not_found' };

@Injectable()
export class IdentityService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
  ) {}

  /**
   * Resolves the company the session is working in, if any.
   *
   * The session's identifier is a starting point, not an answer. It is matched against the
   * person's live memberships, so a membership revoked mid-session drops the context on the very
   * next request rather than when the session eventually expires.
   */
  async currentContext(principal: AuthenticatedPrincipal): Promise<CompanyContext | null> {
    if (!principal.activeCompanyId) return null;

    const memberships = await this.ownMemberships(principal.userId);

    return contextFor(memberships, principal.activeCompanyId);
  }

  /** Everything `/me` reports, computed server side. */
  async describe(principal: AuthenticatedPrincipal): Promise<MeView> {
    const { user, memberships } = await this.uow.inPrincipalScope(
      principalScope({ userId: principal.userId }),
      async (repos) => ({
        user: await repos.users.findById(principal.userId),
        memberships: await repos.memberships.listOwn(),
      }),
    );

    if (!user) {
      // The session outlived the user row. Nothing legitimate produces this, so it is an error
      // rather than an empty answer.
      throw new Error('Session resolved to a user that no longer exists');
    }

    const context = principal.activeCompanyId
      ? contextFor(memberships, principal.activeCompanyId)
      : null;

    const companies = await this.namesFor(memberships);
    // No company entered means no grants. Not an empty company's grants, and not the grants of
    // whichever company happens to be first: authorization is a question about a company, and
    // with none chosen there is nothing to answer it against.
    const grants = context
      ? await this.authorization.grantsFor(context, principal.userId)
      : NO_GRANTS;
    const active = context ? companies.find((c) => c.id === context.companyId) : undefined;

    return {
      user: { id: user.id, email: user.email, name: user.name },
      companies: companies.map((company) => ({
        id: company.id,
        name: company.name,
        isActive: company.id === context?.companyId,
      })),
      activeCompany: active ? { id: active.id, name: active.name } : null,
      roles: grants.roles,
      permissions: [...grants.permissions],
    };
  }

  /**
   * Enters a company.
   *
   * Membership is checked twice and the second check is the one that counts. The first finds
   * which tenant the company belongs to, which a company identifier alone does not say. The
   * second runs inside the transaction that writes the change, in the scope of the target
   * company, so a membership revoked between the two is caught by the write rather than
   * honoured by it.
   */
  async switchCompany(input: {
    principal: AuthenticatedPrincipal;
    companyId: string;
  }): Promise<SwitchCompanyResult> {
    const { principal, companyId } = input;

    const memberships = await this.ownMemberships(principal.userId);
    const candidate = contextFor(memberships, companyId);
    if (!candidate) return { outcome: 'not_found' };

    const previous = principal.activeCompanyId;

    return this.uow.inActorScope(
      actorScope({
        tenantId: candidate.tenantId,
        companyId: candidate.companyId,
        userId: principal.userId,
      }),
      async (repos) => {
        // The check that counts. Under this scope row level security is already comparing every
        // statement against the target tenant and company, so a membership that is absent,
        // revoked or another tenant's simply does not come back.
        const membership = await repos.memberships.findOwnForActiveCompany();
        if (!membership) return { outcome: 'not_found' };

        // Writes the company this transaction is scoped to. It takes no company argument, so
        // there is no way for the value written to differ from the one just verified.
        await repos.sessions.setActiveCompany({ id: principal.sessionId });

        await repos.audit.append({
          action: 'switched_company',
          entityType: 'session',
          entityId: principal.sessionId,
          summary: 'Switched active company',
          // Structured, per section 7.2. A rendered sentence would freeze today's formatting
          // into a permanent record and could not be queried.
          changes: { activeCompanyId: { from: previous, to: candidate.companyId } },
        });

        return { outcome: 'switched', context: candidate };
      },
    );
  }

  private ownMemberships(userId: string): Promise<MembershipRecord[]> {
    return this.uow.inPrincipalScope(principalScope({ userId }), (repos) =>
      repos.memberships.listOwn(),
    );
  }

  /**
   * Puts names on companies whose membership is already established.
   *
   * One read per tenant, because a person may belong to companies in more than one and each
   * tenant's rows are only reachable in that tenant's context. The identifiers passed in came
   * from that person's own membership rows, so this decides nothing about who may see what; it
   * is a lookup after the decision, which is why a named system scope is the right shape and an
   * actor scope is not.
   */
  private async namesFor(
    memberships: MembershipRecord[],
  ): Promise<{ id: string; name: string }[]> {
    const byTenant = new Map<string, string[]>();
    for (const membership of memberships) {
      const companies = byTenant.get(membership.tenantId) ?? [];
      companies.push(membership.companyId);
      byTenant.set(membership.tenantId, companies);
    }

    const found: { id: string; name: string }[] = [];
    for (const [tenantId, companyIds] of byTenant) {
      const companies = await this.uow.inSystemScope(
        systemScope('company-directory', { tenantId }),
        (repos) => repos.companies.listByIds(companyIds),
      );
      found.push(...companies.map((company) => ({ id: company.id, name: company.name })));
    }

    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

}

/**
 * Finds the membership matching a company identifier, and turns it into a context.
 *
 * A plain array search rather than a query, because the array is the answer to "what may this
 * person enter" and the identifier is a selection within it. Nothing outside the array can be
 * selected, which is the property that makes a client supplied identifier harmless here.
 */
function contextFor(
  memberships: MembershipRecord[],
  companyId: string,
): CompanyContext | null {
  const membership = memberships.find((m) => m.companyId === companyId);
  if (!membership) return null;

  return {
    tenantId: membership.tenantId,
    companyId: membership.companyId,
    membershipId: membership.id,
  };
}
