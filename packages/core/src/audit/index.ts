export { BufferedAuditRecorder, createAuditBuilder, InMemoryAuditSink } from './builder';
export type {
  AuditBuilder,
  AuditContext,
  AuditDenial,
  AuditErrorReason,
  AuditRecord,
  AuditResource,
  AuditResourceType,
  AuditSink,
} from './builder';

export {
  looksLikeCredential,
  REDACTED,
  redactUrlCredentials,
  redactValue,
  sanitizeMetadataString,
} from './redaction';

export type {
  ActorType,
  AuditAccessCeiling,
  AuditAction,
  AuditEvent,
  AuditMetadata,
  AuditOutcome,
} from './types';
