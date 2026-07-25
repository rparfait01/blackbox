import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { envelopeEncryptionEnabled } from '@/lib/env';

/**
 * Brief 29 §-1 — the non-negotiables, pinned structurally.
 *
 * This brief is PURELY ADDITIVE. It must be impossible for the certified report to reach
 * into the trigger, the capture, closure, dispatch, or the intake — and impossible for the
 * verifier to become something the running system depends on. Prose promises drift; these
 * assertions do not.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

/** Every .ts/.tsx under src, excluding tests. */
function allSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry) || entry === 'test-fixtures.ts') continue;
      out.push(full);
    }
  };
  walk(SRC);
  return out;
}

const REPORT_DIR = join(SRC, 'lib', 'report');
const REPORT_UI = join(SRC, 'routes', 'settings', 'CertifiedReport.tsx');

/** Module specifiers this file actually imports — the real dependency edges, as opposed to
 *  module names that merely appear in a comment. */
function importSpecifiers(src: string): string[] {
  return [...src.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

describe('§-1 [A] fully behind the flag', () => {
  it('the envelope flag defaults OFF, so this brief is inert today', () => {
    expect(envelopeEncryptionEnabled).toBe(false);
  });

  it('the Settings entry point is rendered only when the flag is armed', () => {
    const settings = read('./routes/settings/Settings.tsx');
    expect(settings).toMatch(/\{envelopeEncryptionEnabled \? \([\s\S]*?Start a certified report/);
  });

  it('the flow itself refuses when the flag is off — belt and braces', () => {
    const ui = read('./routes/settings/CertifiedReport.tsx');
    expect(ui).toMatch(/useState<Step>\(envelopeEncryptionEnabled \? 'intro' : 'blocked'\)/);
    expect(read('./lib/report/generate.ts')).toMatch(/if \(!envelopeEncryptionEnabled\)[\s\S]*?reason: 'disabled'/);
  });
});

describe('§-1 [A] touches NOTHING that exists', () => {
  const OPERATIONAL = [
    './lib/upload/upload-manager.ts',
    './lib/capture/media-capture.ts',
    './lib/closure/index.ts',
    './lib/active-alert.ts',
    './lib/auth.ts',
    './lib/activation/heartbeat.ts',
    './lib/activation/session-monitor.ts',
    './routes/settings/GuidedIntake.tsx',
    './lib/intake/case-file.ts',
  ];

  it('no operational module imports anything from the report', () => {
    for (const f of OPERATIONAL) {
      const src = read(f);
      expect(src, `${f} must not reference the report`).not.toMatch(/lib\/report|CertifiedReport/);
    }
  });

  it('the report never imports the trigger, capture, closure, or dispatch paths', () => {
    for (const file of [...allSources().filter((f) => f.startsWith(REPORT_DIR)), REPORT_UI]) {
      const rel = relative(SRC, file);
      // Check IMPORT SPECIFIERS, not prose — a comment may legitimately name a module it
      // does not depend on (evidence.ts explains which id upload-manager binds as the AAD).
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        expect(spec, `${rel} must not import ${spec}`).not.toMatch(
          /lib\/capture\/|upload\/upload-manager|lib\/closure|active-alert/,
        );
      }
    }
  });

  it('the report reads capture material but never writes any', () => {
    const generate = read('./lib/report/generate.ts');
    // Only GETs, plus the one POST that carries two hashes for signature.
    expect(generate).toMatch(/'\/v1\/me\/reports\/sign'/);
    expect(generate).not.toMatch(/\/v1\/events|\/v1\/chunks|method: 'DELETE'|method: 'PUT'/);
  });
});

describe('§-1 [A] reuses, never re-implements', () => {
  it('uses the SHIPPED envelope + decryptor rather than new crypto', () => {
    const evidence = read('./lib/report/evidence.ts');
    expect(evidence).toMatch(/from '@\/lib\/crypto\/capture-decryptor'/);
    // No second crypto stack: the report never calls WebCrypto primitives directly.
    for (const f of ['./lib/report/evidence.ts', './lib/report/generate.ts', './routes/settings/CertifiedReport.tsx']) {
      expect(read(f), `${f} must not open its own crypto`).not.toMatch(/crypto\.subtle\./);
    }
  });

  it('canonicalization and the document format come from the ONE shared implementation', () => {
    expect(read('./lib/report/canonical.ts')).toMatch(/export \{[\s\S]*?\} from '@blackbox\/shared'/);
    expect(read('./lib/report/document.ts')).toMatch(/from '@blackbox\/shared'/);
    expect(read('./lib/report/verify.ts')).toMatch(/from '@blackbox\/shared'/);
  });
});

describe('§-1 [A] the verifier is a LEAF', () => {
  it('nothing in the app imports the verifier — deleting it changes nothing', () => {
    const importers = allSources().filter((f) => {
      if (f.startsWith(REPORT_DIR)) return false; // the report lib's own re-export
      return /lib\/report\/verify|report-verify/.test(readFileSync(f, 'utf8'));
    });
    expect(importers.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('the report UI is reachable ONLY from Settings', () => {
    const importers = allSources().filter((f) =>
      importSpecifiers(readFileSync(f, 'utf8')).some((s) => /CertifiedReport$/.test(s)),
    );
    expect(importers.map((f) => relative(SRC, f))).toEqual([join('routes', 'settings', 'Settings.tsx')]);
  });

  it('the router does not route to the report or the verifier', () => {
    expect(read('./app/router.tsx')).not.toMatch(/CertifiedReport|verification|report/i);
  });
});

describe('§1 [A] no AI, and no assertion, anywhere in the evidence zone', () => {
  it('the report never calls a model or an inference endpoint', () => {
    for (const file of [...allSources().filter((f) => f.startsWith(REPORT_DIR)), REPORT_UI]) {
      const src = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      expect(src, `${rel} must contain no model call`).not.toMatch(
        /openai|anthropic|\bllm\b|completion|classifier|summari[sz]e\(|inference/i,
      );
    }
  });

  it('the evidence builder is deterministic — no ambient clock, no randomness', () => {
    const evidence = read('./lib/report/evidence.ts');
    expect(evidence).not.toMatch(/Date\.now\(\)|Math\.random\(\)|crypto\.randomUUID/);
    // Time enters as an input, so the same inputs always produce the same bytes.
    expect(evidence).toMatch(/generatedAt: number/);
  });
});

describe('§2 [A] the signing key is server-side', () => {
  it('the client holds no signing key and signs nothing itself', () => {
    for (const file of [...allSources().filter((f) => f.startsWith(REPORT_DIR)), REPORT_UI]) {
      const src = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      expect(src, `${rel} must not hold a signing key`).not.toMatch(/SIGNING_KEY|privateKey.*sign|subtle\.sign/);
    }
  });

  it('only the two hashes are sent for signature — never the content', () => {
    const generate = read('./lib/report/generate.ts');
    expect(generate).toMatch(/body: \{ eventId, evidenceHash: hashes\.evidenceHash, renderedHash: hashes\.renderedHash \}/);
    // The evidence object itself is never placed in a request body.
    expect(generate).not.toMatch(/body: \{[^}]*\bevidence\b[^}]*\}/);
  });
});

describe('§4 the custody caution gates the download', () => {
  it('the file cannot be produced without passing through the caution step', () => {
    const ui = read('./routes/settings/CertifiedReport.tsx');
    expect(ui).toMatch(/Once you download this report, we can no longer protect its privacy/);
    // download() is wired to the caution screen and nowhere else.
    const handlers = ui.match(/onClick=\{download\}/g) ?? [];
    expect(handlers).toHaveLength(1);
    const cautionBlock = ui.slice(ui.indexOf("step === 'caution'"), ui.indexOf("step === 'done'"));
    expect(cautionBlock).toContain('onClick={download}');
  });
});

describe('§0a the Hidden facade shows no report', () => {
  const facades = [
    './routes/meditation/MeditationHome.tsx',
    './routes/meditation/BreathingCircles.tsx',
    './routes/meditation/HoldProgressRing.tsx',
  ];
  it('no facade surface references the report, certification, or verification', () => {
    for (const f of facades) {
      expect(read(f), `${f} must not reference the report`).not.toMatch(
        /CertifiedReport|certified|verification|evidence/i,
      );
    }
  });
});
