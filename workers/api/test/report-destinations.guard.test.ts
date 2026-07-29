import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * REPORT DESTINATIONS, server side — the half of the promise the client cannot keep alone.
 *
 * The client can say "BLACK BOX never holds your report" all it likes; only the server can
 * make it true. Two destinations, and the difference between them is the whole point:
 *
 *   OFFICIAL / PERSONAL report → NO destination here. There is no table, no bucket, and no
 *   endpoint that accepts one. The server's entire role is to sign two hashes it cannot
 *   invert and hand back a signature. This is the one asserted below by exhaustion: no
 *   migration anywhere creates a store for it.
 *
 *   ANONYMOUS tally → the ONE report destination BLACK BOX operates, and it operates the
 *   pipe without owning identifiable content: a store with no column that could link to an
 *   account, published only as a k-anonymized aggregate.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const MIGRATIONS = join(HERE, '..', 'migrations');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

function allSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith('.ts')) out.push(full);
    }
  };
  walk(SRC);
  return out;
}

const allMigrations = (): string[] => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));

describe('[A] the OFFICIAL report has NO central store', () => {
  it('no migration ever creates a table to hold a report document', () => {
    for (const file of allMigrations()) {
      const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
      const tables = [...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)/gi)].map((m) => m[1].toLowerCase());
      for (const table of tables) {
        // `closure_reports` is the operational closure record, not a survivor report — it
        // predates this path entirely and holds no report content.
        if (table === 'closure_reports') continue;
        expect(table, `${file} creates ${table} — a report store would break the promise`).not.toMatch(
          /^(certified_)?reports?$|report_documents?|report_files?|report_content/,
        );
      }
    }
  });

  it('nothing in the Worker writes a report anywhere — the signing path only READS', () => {
    const attestation = read('lib/report-attestation.ts');
    expect(attestation).not.toMatch(/INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM/i);
    expect(attestation).not.toMatch(/env\.MEDIA|env\.VAULT|\.put\(/);
    // The report libraries READ her stored ciphertext (report-metadata hands back a chunk so
    // her device can decrypt it) — but not one of them WRITES. A report never becomes an
    // object in our storage, and no report path can delete her material either.
    for (const file of allSources()) {
      const rel = relative(SRC, file);
      if (!/report-(attestation|metadata|signing)\.ts$/.test(rel)) continue;
      const src = readFileSync(file, 'utf8');
      expect(src, `${rel} must not write storage`).not.toMatch(/env\.(MEDIA|VAULT)\.(put|delete)\(/);
      expect(src, `${rel} must not write the database`).not.toMatch(/INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM/i);
    }
  });

  it('the sign route persists a fingerprint for audit, never content', () => {
    const user = read('routes/user.ts');
    const at = user.indexOf("userRoutes.post('/reports/sign'");
    const route = user.slice(at, user.indexOf('// Brief 27 §5 Destination 1', at));
    // The audit row carries the hash and the chain position — values that cannot be inverted
    // into the document. Auditing WHO certified WHAT and WHEN is required; storing the report
    // is exactly what must never happen.
    expect(route).toMatch(/audit\(c\.env, eventId, 'report_certified'[\s\S]*?evidenceHash/);
    expect(route).not.toMatch(/INSERT INTO|\.put\(/);
  });

  it('there is no endpoint anywhere that ACCEPTS a report document', () => {
    for (const file of allSources()) {
      const src = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      // A POST/PUT whose body names the document rather than its hashes would be the leak.
      expect(src, `${rel} must accept no report body`).not.toMatch(
        /\.(post|put)\([^)]*['"][^'"]*report[^'"]*['"][\s\S]{0,400}?(reportHtml|document|renderedReport|reportBody)/i,
      );
    }
  });
});

describe('[A] the ANONYMOUS tally reaches the severed public store', () => {
  const schema = readFileSync(join(MIGRATIONS, '0032_incident_tally.sql'), 'utf8');

  it('the store has no column that could link a row to a person', () => {
    const create = schema.slice(schema.indexOf('CREATE TABLE'), schema.indexOf(');'));
    expect(create).not.toMatch(/userId|deviceId|eventId|orgId|sessionId|ip\b|email|phone|createdAt/i);
    // Only the month is kept — a precise instant is itself an identifier.
    expect(create).toMatch(/submissionMonth TEXT NOT NULL/);
    // No free text: there is nowhere to type something re-identifying.
    expect(create).not.toMatch(/notes?|freeText|description|comment/i);
  });

  it('the write path never records the sender on the row', () => {
    const tally = read('lib/tally.ts');
    const insert = tally.slice(tally.indexOf('INSERT INTO incident_tally'), tally.indexOf('INSERT INTO incident_tally') + 400);
    expect(insert).not.toMatch(/userId|deviceId|orgId/);
  });

  it('it is published as a suppressed public aggregate — the open-data destination', () => {
    const index = read('index.ts');
    expect(index).toMatch(/app\.get\('\/v1\/tally\/stats'/);
    expect(index).toMatch(/suppressionThreshold: SUPPRESSION_THRESHOLD/);
    expect(read('lib/tally.ts')).toMatch(/suppressedAggregate\(env, 'incident_tally'/);
  });

  it('no route can read an individual tally row — aggregate only', () => {
    for (const file of allSources()) {
      const src = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      if (/lib[\\/]tally\.ts$/.test(rel)) continue;
      expect(src, `${rel} must not read tally rows`).not.toMatch(/SELECT[\s\S]{0,120}FROM incident_tally/i);
    }
    // Even inside tally.ts, the only read is the grouped aggregate.
    expect(read('lib/tally.ts')).not.toMatch(/SELECT \* FROM incident_tally/i);
  });
});
