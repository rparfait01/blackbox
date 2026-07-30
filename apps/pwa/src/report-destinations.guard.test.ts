import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * REPORT DESTINATIONS · SETTINGS LINKS · REAR CAMERA — the three groups, pinned structurally.
 *
 * Each of these is a promise that reads as true in prose long after it has stopped being true
 * in code: "the rear camera is the default", "we hold no copy of her report", "there are no
 * dead links". Prose drifts. These assertions do not.
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

const FACADES = [
  './routes/meditation/MeditationHome.tsx',
  './routes/meditation/BreathingCircles.tsx',
  './routes/meditation/HoldProgressRing.tsx',
];

const CAPTURE = read('./lib/capture/media-capture.ts');
const SETTINGS = read('./routes/settings/Settings.tsx');

// ─────────────────────────────────────────────────────────────────────────────────────────
// GROUP 1 — the camera faces AWAY from her.
// ─────────────────────────────────────────────────────────────────────────────────────────

describe('GROUP 1 [A] video capture defaults to the REAR camera', () => {
  it('asks for the rear lens first, and never asks for the front one', () => {
    expect(CAPTURE).toMatch(/facingMode: \{ exact: 'environment' \}/);
    expect(CAPTURE).toMatch(/facingMode: \{ ideal: 'environment' \}/);
    // The front-camera default is what this brief removed. In an emergency the phone is not
    // turned around, so 'user' would record the survivor's own face instead of the threat.
    expect(CAPTURE, "the front camera must never be requested").not.toMatch(/facingMode[^;]*'user'/);
  });

  it('a missing rear lens DEGRADES, it never fails — some capture beats none', () => {
    const ladder = CAPTURE.slice(
      CAPTURE.indexOf('private async acquireStream'),
      CAPTURE.indexOf('/** Mount an off-screen'),
    );
    // The ladder relaxes on failure rather than returning at the first rung...
    expect(ladder).toMatch(/for \(const video of videoConstraints\)/);
    // ...and its last rung names NO camera, so a front-only device still records. It carries
    // only the quality budget (Item A) — a preference, never a camera selector. Asserted as
    // "constrains no camera" rather than "is literally {}", so adding quality hints cannot
    // silently turn this rung into another way to fail.
    const lastRung = ladder.slice(ladder.lastIndexOf('{ ...VIDEO_QUALITY }'), ladder.indexOf('];'));
    expect(lastRung, 'the final rung must exist').not.toBe('');
    expect(lastRung, 'the final rung must select no camera').not.toMatch(/facingMode|deviceId/);
    // The last rung of all is audio-only: never lose audio + location over a camera.
    expect(CAPTURE).toMatch(/getUserMedia\(\{ audio: true, video: false \}\)/);
  });

  it('the covert path never acquires a camera at all (§0a)', () => {
    expect(read('./lib/capture/config.ts')).toMatch(/source === 'direct-tap' \? 'audio-video' : 'audio'/);
  });

  it('capture is not gated or taxed — no auth, entitlement, or network check before recording', () => {
    expect(CAPTURE).not.toMatch(/entitlement|activated|paywall|requireSession|getSessionToken/);
    expect(CAPTURE).not.toMatch(/\bapi\(|\bfetch\(/);
  });

  it('there is NO camera-selection UI or indicator anywhere — the survivor does nothing', () => {
    // Only the two capture modules may name a camera constraint; no screen may.
    const owners = [join('lib', 'capture', 'media-capture.ts'), join('lib', 'permissions.ts')];
    for (const file of allSources()) {
      const rel = relative(SRC, file);
      if (owners.includes(rel)) continue;
      // Naming it in a comment is fine; CALLING it outside the two capture modules is not.
      expect(readFileSync(file, 'utf8'), `${rel} must not select a camera`).not.toMatch(
        /facingMode|mediaDevices\.getUserMedia/,
      );
    }
    // And no screen carries a "hold still / turn the phone" instruction. Capture is silent
    // and automatic: under threat she has no attention to spend on aiming a phone.
    for (const file of allSources().filter((f) => f.endsWith('.tsx'))) {
      expect(readFileSync(file, 'utf8'), `${relative(SRC, file)} must not instruct the survivor`).not.toMatch(
        /hold still|turn the phone|point the camera|face the camera/i,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// GROUP 2 — two reports, two destinations, never conflated.
// ─────────────────────────────────────────────────────────────────────────────────────────

describe('GROUP 2 [A] the OFFICIAL report is hers — there is no central store', () => {
  it('the only thing that ever leaves the device is the two-hash signature request', () => {
    const generate = read('./lib/report/generate.ts');
    expect(generate.match(/method: 'POST'/g) ?? [], 'exactly one POST on the report path').toHaveLength(1);
    expect(generate).toMatch(/'\/v1\/me\/reports\/sign'/);
    expect(generate).toMatch(
      /body: \{ eventId, evidenceHash: hashes\.evidenceHash, renderedHash: hashes\.renderedHash \}/,
    );
    // No route that would hand the document to anyone, including us.
    expect(generate).not.toMatch(/method: 'PUT'|upload|\/v1\/me\/reports\/(store|save|documents)/i);
  });

  it('the document is assembled and produced BY THE DEVICE — never fetched from a server', () => {
    const ui = read('./routes/settings/CertifiedReport.tsx');
    expect(ui).toMatch(/buildReportFile\(evidence, signed, statement\)/);
    expect(ui).toMatch(/URL\.createObjectURL/);
    expect(ui).toMatch(/a\.download = /);
  });

  it('the UI says plainly that it is hers and that its privacy becomes hers', () => {
    expect(SETTINGS).toMatch(/we keep no copy/);
    const ui = read('./routes/settings/CertifiedReport.tsx');
    expect(ui).toMatch(/We keep no copy/);
    expect(ui).toMatch(/Once you download this report, we can no longer protect its privacy/);
    expect(ui).toMatch(/Its privacy is now yours to manage/);
  });

  it('the screen carries the SAME name as the entry that opened it', () => {
    const ui = read('./routes/settings/CertifiedReport.tsx');
    expect(ui).toMatch(/>Official report</);
    expect(ui).toMatch(/<Primary onClick=\{\(\) => setStep\('pick'\)\}>Start an official report<\/Primary>/);
    // The old generic name is gone from both ends — it was one word away from the intake's.
    expect(ui).not.toMatch(/>Start a report</);
  });
});

describe('GROUP 2 [A] the ANONYMOUS report goes to the severed public store', () => {
  const tally = read('./routes/settings/AnonymousTally.tsx');

  it('the payload carries nothing that could link back to her', () => {
    const body = tally.slice(tally.indexOf('api<'), tally.indexOf('if (res.ok)'));
    expect(body).not.toMatch(/userId|deviceId|eventId|sessionToken|email|phone/i);
  });

  it('it states its destination and its irreversibility BEFORE she sends', () => {
    expect(tally).toMatch(/public statistics/i);
    expect(tally).toMatch(/can’t be taken back/);
    // ...and the Settings entry says both, so she knows before she even opens it.
    expect(SETTINGS).toMatch(/public statistics[\s\S]{0,240}can’t be taken back/);
  });

  it('it is never auto-populated from a capture or an event — that would re-identify', () => {
    expect(tally).not.toMatch(/listReportableEvents|\/v1\/me\/reports|\/v1\/me\/events/);
  });
});

describe('GROUP 2 [A] review is a third thing, and produces no file', () => {
  const review = read('./routes/settings/EvidenceReview.tsx');

  it('evidence review has no download, export, or share path', () => {
    expect(review).not.toMatch(/\.download\s*=/);
    expect(review).not.toMatch(/navigator\.share|createElement\('a'\)/);
  });

  it('what it opens is released when the screen closes — nothing is left resident', () => {
    expect(review).toMatch(/revokeReview/);
    expect(read('./lib/report/playback.ts')).toMatch(/URL\.revokeObjectURL/);
  });

  it('decrypted evidence does not survive backgrounding or being left untouched', () => {
    // Someone picking up her phone must find settings, not the worst moment of her life.
    expect(review).toMatch(/document\.addEventListener\('visibilitychange'/);
    expect(review).toMatch(/window\.addEventListener\('pagehide'/);
    expect(review).toMatch(/Date\.now\(\) - lastActivity\.current > IDLE_CLEAR_MS/);
    // ...and playback counts as attention, so watching is never cut off mid-recording.
    expect(review).toMatch(/onTimeUpdate=\{touch\}/);
  });

  it('nothing plays at her — opening is deliberate', () => {
    // The JSX attributes and the imperative call, not the words: `autoPlay` is React's
    // spelling, `loop` the replay attribute, `.play()` the way to start one uninvited.
    expect(review).not.toMatch(/autoPlay|\bloop\b|\.play\(\)/);
  });

  it('access is unlimited — no counter, cap, or cooldown anywhere on the path', () => {
    for (const src of [review, read('./lib/report/playback.ts')]) {
      expect(src).not.toMatch(/viewCount|viewsRemaining|cooldown|rateLimit|maxViews|quota/i);
    }
  });

  it('it points at the official report for the step that DOES produce a file', () => {
    expect(review).toMatch(/make an official\s*\n?\s*report/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// GROUP 3 — three named entries, none of them dead.
// ─────────────────────────────────────────────────────────────────────────────────────────

const ENTRIES = ['Anonymous report', 'Official report', 'Evidence review'] as const;

/** The rendered block for one Settings group, from its label to the closing tag. */
function groupBlock(label: string): string {
  const at = SETTINGS.indexOf(`<Group label="${label}">`);
  expect(at, `the "${label}" entry must exist`).toBeGreaterThan(-1);
  return SETTINGS.slice(at, SETTINGS.indexOf('</Group>', at));
}

describe('GROUP 3 [A] all three entries are present, named, and described', () => {
  it('each entry exists with its clear label', () => {
    for (const label of ENTRIES) {
      expect(SETTINGS).toContain(`<Group label="${label}">`);
    }
  });

  it('each entry carries a one-line description of what it does', () => {
    for (const label of ENTRIES) {
      expect(groupBlock(label), `"${label}" needs a description`).toMatch(/<p className="mb-3[\s\S]{40,}?<\/p>/);
    }
  });

  it('there is no FOURTH report door — her own words live inside the Official Report', () => {
    // "Written account" was a second door to something the Official Report already contains,
    // which reopened the exact conflation this section exists to prevent.
    expect(SETTINGS).not.toContain('<Group label="Make a report">');
    expect(SETTINGS).not.toContain('<Group label="Written account">');
    expect(SETTINGS).not.toMatch(/>\s*Start a report\s*</);
    expect(SETTINGS).not.toMatch(/GuidedIntake|intakeOpen/);
  });

  it('Settings offers EXACTLY three report entries', () => {
    const groups = [...SETTINGS.matchAll(/<Group label="([^"]+)">/g)].map((m) => m[1]);
    const reportGroups = groups.filter((g) =>
      /report|review|account$/i.test(g) && g !== 'Your account',
    );
    expect(reportGroups).toEqual(['Anonymous report', 'Official report', 'Evidence review']);
  });
});

describe('GROUP 3 [A] no dead links — a gated entry states its state, it does not fail', () => {
  it('the anonymous report is ungated and always actionable', () => {
    expect(groupBlock('Anonymous report')).toMatch(/onClick=\{\(\) => setTallyOpen\(true\)\}/);
    expect(groupBlock('Anonymous report')).not.toMatch(/envelopeEncryptionEnabled/);
  });

  it('each flag-gated entry has BOTH an armed action and an honest unarmed state', () => {
    for (const [label, opener] of [
      ['Official report', 'setReportOpen'],
      ['Evidence review', 'setReviewOpen'],
    ] as const) {
      const block = groupBlock(label);
      expect(block, `"${label}" must gate its action`).toMatch(
        new RegExp(`envelopeEncryptionEnabled \\? \\([\\s\\S]*?${opener}\\(true\\)`),
      );
      expect(block, `"${label}" must state an honest unarmed state`).toMatch(
        /<NotYet>Available when secure storage is enabled<\/NotYet>/,
      );
    }
  });

  it('the unarmed state is not tappable — nothing to press, so nothing to fail', () => {
    const notYet = SETTINGS.slice(SETTINGS.indexOf('function NotYet'));
    expect(notYet.slice(0, 400)).not.toMatch(/onClick|<button|<Link/);
  });

  it('the overlays themselves also refuse when the flag is off — belt and braces', () => {
    expect(read('./routes/settings/CertifiedReport.tsx')).toMatch(
      /useState<Step>\(envelopeEncryptionEnabled \? 'intro' : 'blocked'\)/,
    );
    expect(read('./routes/settings/EvidenceReview.tsx')).toMatch(
      /useState<Step>\(envelopeEncryptionEnabled \? 'pick' : 'blocked'\)/,
    );
    expect(read('./lib/report/playback.ts')).toMatch(/if \(!envelopeEncryptionEnabled\)[\s\S]{0,80}reason: 'disabled'/);
  });
});

describe('GROUP 3 §0a the Hidden facade renders none of this', () => {
  it('no facade surface names any of the three, or imports their screens', () => {
    for (const f of FACADES) {
      const src = read(f);
      expect(src, `${f} must name no report`).not.toMatch(
        /anonymous|tally|official report|certified|evidence|review my/i,
      );
      expect(src, `${f} must import no report screen`).not.toMatch(
        /AnonymousTally|CertifiedReport|EvidenceReview|GuidedIntake/,
      );
    }
  });

  it('the three screens are reachable ONLY from Settings — no route, no other importer', () => {
    const importers = (name: string): string[] =>
      allSources()
        .filter((f) =>
          [...readFileSync(f, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].some((m) =>
            new RegExp(`${name}$`).test(m[1]),
          ),
        )
        .map((f) => relative(SRC, f));
    for (const name of ['AnonymousTally', 'CertifiedReport', 'EvidenceReview']) {
      expect(importers(name), `${name} must be Settings-only`).toEqual([join('routes', 'settings', 'Settings.tsx')]);
    }
    expect(read('./app/router.tsx')).not.toMatch(/AnonymousTally|CertifiedReport|EvidenceReview/);
  });
});
