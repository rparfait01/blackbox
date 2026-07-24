/**
 * Case file (Brief 27 §2) — the structured intake record, and the FAIL-CLOSED sealing
 * that is the whole point of this brief.
 *
 *   A case file is NEVER written in plaintext. Not as a fallback, not while the flag is
 *   off, not on any error. It is sealed to the survivor's own public key on-device before
 *   it leaves, or it is not persisted at all.
 *
 * This inverts the capture path's fail-OPEN rule: a survivor's live capture must land even
 * unencrypted (availability), but a deliberate, structured disclosure must never land
 * unencrypted (confidentiality). sealCaseFile() therefore returns a sealed blob ONLY when
 * encryption is both enabled AND possible; otherwise it returns a refusal and NO bytes.
 */
import { envelopeEncryptionEnabled } from '@/lib/env';
import { importPrivateKey, importPublicKey, openWithPrivateKey, sealToPublicKey, type SealedEnvelope } from '@/lib/crypto/envelope';
import { getStoredEnvelopeKeypair } from '@/lib/storage/user-config';
import { standardizedMapping, TAXONOMY_VERSION, type WhoNature } from './taxonomy';

/** The structured, standards-mapped record. Structured fields are the record of authority
 *  (§3); the narrative + classificationDraft are descriptive and labeled draft. */
export interface CaseFileRecord {
  taxonomyVersion: string;
  incidentTypeId: string | null;
  mapping: { nibrs: string[]; ucr: string; who: WhoNature[] };
  whenRange: string | null;
  /** Location only as granular as the survivor consents (§1). */
  location: { granularity: 'none' | 'region'; regionId?: string };
  relationshipId: string | null;
  weaponCoercionFlags: string[];
  injuryId: string | null;
  reportedToAuthorities: 'yes' | 'no' | 'prefer_not_to_say' | null;
  priorIncidents: 'yes' | 'no' | 'prefer_not_to_say' | null;
  /** Survivor-authored narrative, reviewed before filing. */
  narrative: string;
  /** LABELED DRAFT ONLY — deterministic, descriptive, never the authoritative record. */
  classificationDraft: { threatLevel: string; categories: string[]; summary: string } | null;
  /** Coarse submission month; no precise timestamp lives in the record. */
  submissionMonth: string;
}

/** Assemble a record from the survivor's selections, stamping the standardized mapping. */
export function buildCaseFileRecord(input: Omit<CaseFileRecord, 'taxonomyVersion' | 'mapping'>): CaseFileRecord {
  return {
    ...input,
    taxonomyVersion: TAXONOMY_VERSION,
    mapping: standardizedMapping(input.incidentTypeId),
  };
}

export type SealResult =
  | { ok: true; sealed: string; taxonomyVersion: string }
  | { ok: false; reason: 'secure_storage_unavailable' };

/**
 * Seal a case file to the survivor's own public key. FAIL-CLOSED: both the flag AND a
 * survivor key must be present, or it returns a refusal with NO bytes. There is no branch
 * that produces a plaintext blob — a caller literally cannot obtain one from this function.
 */
export async function sealCaseFile(record: CaseFileRecord): Promise<SealResult> {
  if (!envelopeEncryptionEnabled) {
    return { ok: false, reason: 'secure_storage_unavailable' };
  }
  const kp = await getStoredEnvelopeKeypair();
  if (!kp?.publicKey) {
    return { ok: false, reason: 'secure_storage_unavailable' };
  }
  const pub = await importPublicKey(kp.publicKey);
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  const sealed: SealedEnvelope = await sealToPublicKey(bytes, pub);
  return { ok: true, sealed: JSON.stringify(sealed), taxonomyVersion: record.taxonomyVersion };
}

/** Open a filed case file for review, with the survivor's own private key. Only the
 *  survivor holds the key; the server that stored the sealed blob cannot do this. */
export async function openCaseFile(sealedJson: string, privateKeyB64: string): Promise<CaseFileRecord> {
  const priv = await importPrivateKey(privateKeyB64);
  const bytes = await openWithPrivateKey(JSON.parse(sealedJson) as SealedEnvelope, priv);
  return JSON.parse(new TextDecoder().decode(bytes)) as CaseFileRecord;
}
