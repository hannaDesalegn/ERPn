/** Users and the audit trail. */

import type { AuditEvent, User } from '@/domain';
import { db } from '@/mocks/db';
import { delay, queryList, type ListParams, type Paginated } from './client';

export const adminService = {
  async listUsers(): Promise<User[]> {
    return delay(db.users);
  },

  async listAuditEvents(params: ListParams = {}): Promise<Paginated<AuditEvent>> {
    return delay(
      queryList(db.auditEvents, params, {
        searchFields: (e) => [e.summary, e.actor.name, e.target.docNumber],
        filterAccessors: {
          action: (e) => e.action,
          actorId: (e) => e.actor.id,
          docType: (e) => e.target.docType,
        },
        sortAccessors: { occurredAt: (e) => e.occurredAt },
        defaultSort: { by: 'occurredAt', dir: 'desc' },
      }),
    );
  },

  /**
   * Audit history for one specific record — the "who touched this" panel on a
   * document screen. A real backend indexes on (targetType, targetId).
   */
  async auditForDocument(targetId: string): Promise<AuditEvent[]> {
    return delay(db.auditEvents.filter((e) => e.target.id === targetId));
  },

  async recentActivity(limit = 12): Promise<AuditEvent[]> {
    return delay(db.auditEvents.slice(0, limit));
  },
};
