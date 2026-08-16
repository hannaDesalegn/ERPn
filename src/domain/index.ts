/**
 * Single import surface for the domain layer.
 *
 * Everything the rest of the app knows about the business lives behind this
 * barrel. Components import from '@/domain', never from a service or a mock
 * file, so the source of the data can change without touching the UI.
 */

export * from './primitives';
export * from './parties';
export * from './catalog';
export * from './inventory';
export * from './sales';
export * from './purchasing';
export * from './billing';
export * from './accounting';
export * from './security';
export * from './audit';
export * from './dashboard';
