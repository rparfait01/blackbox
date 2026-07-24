/**
 * Case files (Brief 27 §2) — server storage of the survivor-sealed case file. The server
 * stores ONLY the sealed envelope (ciphertext under the survivor's own public key) and can
 * open none of it. There is no plaintext column and no decrypt path here.
 *
 * The SECOND fail-closed gate lives at the endpoint: a write is refused unless
 * ENVELOPE_ENCRYPTION_ENABLED is armed, so even a misbehaving client cannot persist a case
 * file while zero-knowledge custody is off. Belt and braces — the guarantee never rests on
 * one check.
 */
import type { CaseFileRow, Env } from '../types';

/** Is the zero-knowledge custody gate armed? Case files may only be written when it is. */
export function envelopeEnabled(env: Env): boolean {
  return env.ENVELOPE_ENCRYPTION_ENABLED === 'true';
}

/** Store a survivor-sealed case file. The caller (endpoint) has already verified the flag. */
export async function storeCaseFile(
  env: Env,
  input: { userId: string; sealedCaseFile: string; taxonomyVersion: string },
): Promise<CaseFileRow> {
  const row: CaseFileRow = {
    id: crypto.randomUUID(),
    userId: input.userId,
    sealedCaseFile: input.sealedCaseFile,
    taxonomyVersion: input.taxonomyVersion,
    createdAt: Date.now(),
  };
  await env.DB.prepare(
    'INSERT INTO case_files (id, userId, sealedCaseFile, taxonomyVersion, createdAt) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(row.id, row.userId, row.sealedCaseFile, row.taxonomyVersion, row.createdAt)
    .run();
  return row;
}

/** List the owner's case files (metadata only — the sealed blob is fetched per file). */
export async function listCaseFiles(
  env: Env,
  userId: string,
): Promise<Array<{ id: string; taxonomyVersion: string; createdAt: number }>> {
  const { results } = await env.DB.prepare(
    'SELECT id, taxonomyVersion, createdAt FROM case_files WHERE userId = ? ORDER BY createdAt DESC',
  )
    .bind(userId)
    .all<{ id: string; taxonomyVersion: string; createdAt: number }>();
  return results;
}

/** Fetch one case file's sealed blob — OWNER-SCOPED. Returns null for a non-owner or a
 *  missing file (no cross-account access to a sealed disclosure). */
export async function getCaseFileSealed(env: Env, userId: string, id: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT sealedCaseFile FROM case_files WHERE id = ? AND userId = ?')
    .bind(id, userId)
    .first<{ sealedCaseFile: string }>();
  return row?.sealedCaseFile ?? null;
}
