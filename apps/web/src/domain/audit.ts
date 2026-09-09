/**
 * Audit trail.
 *
 * An ERP has to answer four questions about any record:
 *   Who did this?  What changed?  When?  What was it before?
 *
 * HONEST STATEMENT OF WHAT THIS IS AND IS NOT
 * -------------------------------------------
 * What follows is a UI contract and a data expectation. It is NOT a secure audit
 * system, and the frontend cannot make it one. A trustworthy audit trail
 * requires the backend to:
 *   - write the entry inside the same database transaction as the change, so a
 *     change can never exist without its audit record
 *   - take the actor from the authenticated session, never from the request body
 *   - make the audit table append-only, with no UPDATE or DELETE grant even for
 *     application accounts
 *
 * We define the shape so the backend has a clear target, and so the UI already
 * has somewhere to render it.
 *
 * Distinguish two related things:
 *   ACTIVITY FEED  human-readable "what happened", for operational awareness.
 *   AUDIT LOG      field-level before/after, for investigation and compliance.
 * The same event feeds both; they differ in detail level and audience.
 */

import type { DocumentRef, ID, ISODateTime, UserRef } from './primitives';

export type AuditAction =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'confirmed'
  | 'approved'
  | 'rejected'
  | 'posted'
  | 'cancelled'
  | 'reversed'
  | 'paid'
  | 'shipped'
  | 'received'
  | 'logged_in'
  | 'permission_changed';

/** One field that changed, with its old and new value. */
export interface FieldChange {
  field: string;
  label: string;
  /** Rendered as text. Typed values are the backend's problem, not the UI's. */
  before: string | null;
  after: string | null;
}

export interface AuditEvent {
  id: ID;
  occurredAt: ISODateTime;
  actor: UserRef;
  actorRole: string;
  action: AuditAction;
  /** The record affected. Lets the UI link straight to it. */
  target: DocumentRef | { id: ID; docType: 'customer' | 'supplier' | 'product' | 'user'; docNumber: string };
  /** One-line human summary, e.g. 'Posted invoice INV-2026-0031 for $4,820.00'. */
  summary: string;
  /** Populated for 'updated' events. Empty for state transitions. */
  changes?: FieldChange[];
  /** Captured server-side. Useful in investigations, and impossible to trust from the client. */
  ipAddress?: string;
}
