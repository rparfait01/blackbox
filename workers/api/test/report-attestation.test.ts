/**
 * Brief 29 §2/§5 — the server half of the certified report.
 *
 * The load-bearing properties, in order of how much damage their absence would do:
 *
 *   1. OWNERSHIP. A report is the survivor's. No other account — and no org or operator —
 *      can obtain a signature over someone else's event.
 *   2. NON-CIRCULARITY. The attestation binds the commitments the SERVER holds, not the
 *      ones the device claims. Without this the certification would attest only that the
 *      device said what the device said.
 *   3. HONEST REFUSAL. No commitments (or no key) ⇒ no signature. A report that cannot be
 *      truthfully certified is not certified at all.
 *   4. ZERO KNOWLEDGE. The server signs two hashes. It never receives the content.
 */
import { describe, expect, it } from 'vitest';

import { canonicalize, canonicalHash, REPORT_DOCUMENT_FORMAT } from '@blackbox/shared';
import { signReportAttestation } from '../src/lib/report-attestation';
import { verify } from '../src/lib/integrity';
import type { Env } from '../src/types';

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function makeKeypair(): Promise<{ signingKeyB64: string; publicKeyB64: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return {
    signingKeyB64: bytesToB64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
    publicKeyB64: bytesToB64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))),
  };
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const OWNER = 'user-1';
const EVENT = 'evt-1';

interface FakeRows {
  eventOwner?: string | null;
  commitments?: Array<{ sequence: number; plaintextHash: string }>;
  head?: { seq: number; chainHead: string } | null;
}

/** A minimal D1 stub that answers exactly the three queries this module makes. */
function fakeEnv(keys: { signingKeyB64?: string; publicKeyB64?: string }, rows: FakeRows): Env {
  const commitments = rows.commitments ?? [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          stmt._args = args;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('FROM events')) {
            return rows.eventOwner === undefined ? null : ({ userId: rows.eventOwner } as T);
          }
          if (sql.includes('integrity_heads')) {
            return (rows.head ?? null) as T | null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes('plaintext_commitments')) {
            return { results: commitments as T[] };
          }
          return { results: [] };
        },
      };
      return stmt;
    },
  };
  return {
    DB: db,
    INTEGRITY_SIGNING_KEY: keys.signingKeyB64,
    INTEGRITY_PUBLIC_KEY: keys.publicKeyB64,
  } as unknown as Env;
}

const COMMITMENTS = [
  { sequence: 0, plaintextHash: '1'.repeat(64) },
  { sequence: 1, plaintextHash: '2'.repeat(64) },
];

describe('a report is the OWNER’s — nobody else can obtain a signature', () => {
  it('refuses when the caller does not own the event', async () => {
    const keys = await makeKeypair();
    const env = fakeEnv(keys, { eventOwner: 'someone-else', commitments: COMMITMENTS });
    const result = await signReportAttestation(env, {
      userId: OWNER,
      eventId: EVENT,
      evidenceHash: HASH_A,
      renderedHash: HASH_B,
      now: Date.now(),
    });
    expect(result).toEqual({ ok: false, reason: 'not_owner' });
  });

  it('refuses for an account-less event (userId NULL) — no orphan certification', async () => {
    const keys = await makeKeypair();
    const env = fakeEnv(keys, { eventOwner: null, commitments: COMMITMENTS });
    const result = await signReportAttestation(env, {
      userId: OWNER,
      eventId: EVENT,
      evidenceHash: HASH_A,
      renderedHash: HASH_B,
      now: Date.now(),
    });
    expect(result).toEqual({ ok: false, reason: 'not_owner' });
  });
});

describe('honest refusal — a report that cannot be certified is not certified', () => {
  it('refuses when the capture has NO capture-time commitments', async () => {
    const keys = await makeKeypair();
    const env = fakeEnv(keys, { eventOwner: OWNER, commitments: [] });
    const result = await signReportAttestation(env, {
      userId: OWNER,
      eventId: EVENT,
      evidenceHash: HASH_A,
      renderedHash: HASH_B,
      now: Date.now(),
    });
    expect(result).toEqual({ ok: false, reason: 'no_commitments' });
  });

  it('refuses when no signing key is configured', async () => {
    const env = fakeEnv({}, { eventOwner: OWNER, commitments: COMMITMENTS });
    const result = await signReportAttestation(env, {
      userId: OWNER,
      eventId: EVENT,
      evidenceHash: HASH_A,
      renderedHash: HASH_B,
      now: Date.now(),
    });
    expect(result).toEqual({ ok: false, reason: 'no_signing_key' });
  });
});

describe('the signature is real, and binds what the SERVER holds', () => {
  it('signs the canonical attestation, verifiable with the published key', async () => {
    const keys = await makeKeypair();
    const env = fakeEnv(keys, {
      eventOwner: OWNER,
      commitments: COMMITMENTS,
      head: { seq: 41, chainHead: 'f'.repeat(64) },
    });
    const result = await signReportAttestation(env, {
      userId: OWNER,
      eventId: EVENT,
      evidenceHash: HASH_A,
      renderedHash: HASH_B,
      now: Date.UTC(2026, 6, 25, 10, 0, 1),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { attestation, signature, publicKey } = result.signed;
    expect(publicKey).toBe(keys.publicKeyB64);
    expect(attestation.format).toBe(REPORT_DOCUMENT_FORMAT);
    expect(attestation.alg).toBe('Ed25519');
    expect(attestation.signedAt).toBe('2026-07-25T10:00:01.000Z');
    expect(await verify(canonicalize(attestation), signature, publicKey)).toBe(true);

    // One byte off → verification fails. That is the whole tamper-evidence claim.
    const tampered = { ...attestation, evidenceHash: 'c'.repeat(64) };
    expect(await verify(canonicalize(tampered), signature, publicKey)).toBe(false);
  });

  it('binds the SERVER’s own commitments hash — not one the device supplied', async () => {
    const keys = await makeKeypair();
    const env = fakeEnv(keys, { eventOwner: OWNER, commitments: COMMITMENTS });
    const result = await signReportAttestation(env, {
      userId: OWNER,
      eventId: EVENT,
      evidenceHash: HASH_A,
      renderedHash: HASH_B,
      now: Date.now(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Exactly the hash of the server's own rows — the device has no say in this value.
    expect(result.signed.attestation.commitmentsHash).toBe(await canonicalHash(COMMITMENTS));
  });

  it('binds the integrity-chain head, tying the report to the capture-time chain', async () => {
    const keys = await makeKeypair();
    const env = fakeEnv(keys, {
      eventOwner: OWNER,
      commitments: COMMITMENTS,
      head: { seq: 7, chainHead: 'e'.repeat(64) },
    });
    const result = await signReportAttestation(env, {
      userId: OWNER,
      eventId: EVENT,
      evidenceHash: HASH_A,
      renderedHash: HASH_B,
      now: Date.now(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signed.attestation.chainHead).toBe('e'.repeat(64));
    expect(result.signed.attestation.chainSeq).toBe(7);
  });

  it('carries the two device hashes through unmodified, and nothing else', async () => {
    const keys = await makeKeypair();
    const env = fakeEnv(keys, { eventOwner: OWNER, commitments: COMMITMENTS });
    const result = await signReportAttestation(env, {
      userId: OWNER,
      eventId: EVENT,
      evidenceHash: HASH_A,
      renderedHash: HASH_B,
      now: Date.now(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.signed.attestation.evidenceHash).toBe(HASH_A);
    expect(result.signed.attestation.renderedHash).toBe(HASH_B);
    // ZERO KNOWLEDGE: the signed object holds hashes and custody facts — no content field.
    expect(Object.keys(result.signed.attestation).sort()).toEqual([
      'alg',
      'chainHead',
      'chainSeq',
      'commitmentsHash',
      'eventId',
      'evidenceHash',
      'format',
      'renderedHash',
      'signedAt',
    ]);
  });
});
