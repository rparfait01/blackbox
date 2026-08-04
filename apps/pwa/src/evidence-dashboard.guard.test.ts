import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The evidence review DASHBOARD, pinned structurally.
 *
 * The panels themselves are unit-tested as pure functions; what this file protects is the
 * properties an edit could quietly undo — the summary staying read-only, the map never
 * reaching a third party, and the list naming her recordings in a way she recognises.
 *
 * These are not stylistic preferences. Each one is a promise made to someone who may be
 * reviewing the worst moment of her life on a phone that is not safe to hold for long.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

const REVIEW_UI = read('./routes/settings/EvidenceReview.tsx');
const SUMMARY = read('./lib/review/summary.ts');
const GEO = read('./lib/review/geo.ts');
const WAVEFORM = read('./lib/review/waveform.ts');
const PLAYBACK = read('./lib/report/playback.ts');
const NAMED = [
  ['EvidenceReview.tsx', REVIEW_UI],
  ['summary.ts', SUMMARY],
  ['geo.ts', GEO],
  ['waveform.ts', WAVEFORM],
] as const;

/**
 * Dependencies and endpoints, NOT prose. These files explain at length what they refuse to do
 * — "no geocoder", "the single most damaging inference this screen could make" — and a guard
 * that greps the whole text fires on those very sentences. That would train us to delete the
 * explanations to keep the suite green, which is the opposite of the point.
 *
 * So: what does this module IMPORT, and what URLs does it name?
 */
function importSpecifiers(src: string): string[] {
  return [...src.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
}
function urlLiterals(src: string): string[] {
  return [...src.matchAll(/['"`]([^'"`]*\/\/[^'"`]*)['"`]/g)].map((m) => m[1]);
}

describe('[A] the summary panel is READ-ONLY — it is evidence, not a form', () => {
  it('the screen offers no way to type into or edit the record', () => {
    // No text entry of any kind on this surface. The one thing a survivor may eventually add
    // is a NAME on a person, and that is a separate sealed write — not an edit to this replay.
    expect(REVIEW_UI).not.toMatch(/<input|<textarea|contentEditable|<select\b/);
  });

  it('the review path never writes back — every call it makes is a read', () => {
    for (const src of [REVIEW_UI, PLAYBACK]) {
      expect(src).not.toMatch(/method: '(POST|PUT|PATCH|DELETE)'/);
    }
  });

  it('the panel is derived from the record on every render, so there is no editable copy of it', () => {
    // buildSummaryPanel is called from a useMemo over the fetched rows. A setter holding a
    // mutable summary would be the first step toward an editable one.
    expect(REVIEW_UI).toMatch(/useMemo\(\(\) => buildSummaryPanel\(record\.observations/);
    expect(REVIEW_UI).not.toMatch(/setSummary|setObservations|setRecord\b/);
  });
});

describe('[A] nothing on this screen infers, asserts, or names a person', () => {
  it('no model SDK is imported and no inference endpoint is named', () => {
    for (const [name, src] of NAMED) {
      for (const spec of importSpecifiers(src)) {
        expect(spec, `${name} must not import ${spec}`).not.toMatch(/openai|anthropic|\bai\b|langchain|transformers/i);
      }
      for (const url of urlLiterals(src)) {
        expect(url, `${name} must not call out to ${url}`).not.toMatch(/openai|anthropic|googleapis|inference|\bapi\./i);
      }
    }
  });

  it('the people fields are hard-coded empty — not merely unpopulated today', () => {
    // If a future edit tries to fill these from detected keywords, this fails.
    expect(SUMMARY).toMatch(/aggressors: \[\],/);
    expect(SUMMARY).toMatch(/victims: \[\],/);
  });

  it('a signal outside the fixed mapping is dropped rather than bucketed by guesswork', () => {
    expect(SUMMARY).toMatch(/if \(!bucket\) continue;/);
  });

  it('the mapping is a fixed table, so the same record always yields the same panel', () => {
    // BRIEF 55 §D — the tables moved to @blackbox/shared and this guard follows them there.
    // It used to assert `const WEAPON_CATEGORIES = new Set(` in THIS file, which would now pass
    // only if the review page re-declared its own copy — the exact thing §D removed. What the
    // property was ever about is that the mapping is a FIXED TABLE rather than a heuristic, and
    // that is still checkable; where it is declared was never the point.
    expect(SUMMARY).toMatch(/WEAPON_CATEGORIES/);
    expect(SUMMARY).toMatch(/DANGER_CATEGORIES/);
    expect(SUMMARY).toMatch(/from '@blackbox\/shared'/);
  });

  it('§D2 — the panel renders the CATEGORY, never a matched dictionary token', () => {
    // The defect this replaced: rendering `cat.matches` put the word `don't` on a survivor's
    // evidence page twenty-four times, from a single occurrence in the transcript, beside a
    // weapon field reading "Not recorded". A stopword rendered as a danger spends the
    // credibility of every other field on the page.
    expect(SUMMARY).toMatch(/bucket\.push\(\{ label: categoryLabel\(cat\.category\)/);
    expect(SUMMARY, 'the matched-term list must not reach the panel').not.toMatch(/for \(const term of terms\)/);
  });
});

describe('[A] the map contacts NOTHING — no tiles, no geocoder, no leak', () => {
  it('imports no map library and names no tile or geocoding URL', () => {
    for (const [name, src] of NAMED) {
      for (const spec of importSpecifiers(src)) {
        expect(spec, `${name} must not import ${spec}`).not.toMatch(/leaflet|maplibre|mapbox|ol\/|google.*maps|arcgis/i);
      }
      for (const url of urlLiterals(src)) {
        expect(url, `${name} must not fetch ${url}`).not.toMatch(
          /openstreetmap|mapbox|maps\.google|tile|arcgis|geocod|nominatim/i,
        );
      }
    }
  });

  it('the geometry module makes no network call at all', () => {
    expect(GEO).not.toMatch(/fetch\(|XMLHttpRequest|axios|import\(/);
  });

  it('the location panel is drawn as local SVG from the recorded coordinates', () => {
    expect(REVIEW_UI).toMatch(/<svg viewBox="0 0 100 100"/);
    expect(REVIEW_UI).toMatch(/plotLocations/);
  });

  it('the coordinates are shown, because they — not the drawing — are the record', () => {
    expect(REVIEW_UI).toMatch(/formatCoord\(plot\.start\)/);
  });

  it('a travelled path is drawn ONLY when she actually moved beyond GPS noise', () => {
    // Drawing a line between jittering fixes at one address would depict a journey that never
    // happened, which on an evidence screen is a false statement about her movements.
    expect(REVIEW_UI).toMatch(/plot\.traveling && plot\.points\.length > 1/);
    expect(GEO).toMatch(/export function wasTraveling/);
    expect(GEO).toMatch(/worstAccuracy \* 2/);
  });
});

describe('[A] decrypted material stays in memory and is never persisted', () => {
  it('the waveform is computed from the in-memory blob and never stored', () => {
    expect(WAVEFORM).not.toMatch(/localStorage|sessionStorage|indexedDB|caches\.|showSaveFilePicker/);
    expect(REVIEW_UI).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });

  it('the audio context is always closed, so a review does not hold the audio hardware open', () => {
    expect(WAVEFORM).toMatch(/finally \{/);
    expect(WAVEFORM).toMatch(/ctx\?\.close\(\)/);
  });

  it('a waveform that cannot be produced returns null instead of throwing — audio outranks the picture', () => {
    expect(WAVEFORM).toMatch(/return null/);
    expect(REVIEW_UI).toMatch(/playback and seeking still work/);
  });

  it('the assembled recording is still released on every exit path', () => {
    // Belt-and-braces with report-destinations.guard: the dashboard added exits, and each one
    // must revoke. Three: the header control, the idle/background clear, and back-to-list.
    expect((REVIEW_UI.match(/revokeReview\(openRef\.current\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('[A] the list names her recordings the way she recognises them', () => {
  it('entries are labelled DDMMMYY@HH:MM, replacing the stored identifier', () => {
    expect(REVIEW_UI).toMatch(/formatEvidenceLabel\(e\.createdAt, e\.tzOffsetMinutes\)/);
  });

  it('the raw event id is never shown as the name of a recording', () => {
    // It remains the React key (an identity, not a label) — but it is not rendered as text.
    expect(REVIEW_UI).not.toMatch(/>\{e\.eventId\}</);
  });

  it('newest first is enforced HERE, not merely inherited from the server', () => {
    expect(REVIEW_UI).toMatch(/sort\(\(a, b\) => b\.createdAt - a\.createdAt\)/);
  });
});

describe('[A] the whole record comes from ONE fetch, so no panel can describe a different event', () => {
  it('the summary, transcript and location rows ride along with the media', () => {
    expect(PLAYBACK).toMatch(/export interface ReviewRecord/);
    expect(PLAYBACK).toMatch(/observations: meta\.classifications \?\? \[\]/);
    expect(PLAYBACK).toMatch(/fragments: meta\.transcripts \?\? \[\]/);
    expect(PLAYBACK).toMatch(/locations: meta\.locations \?\? \[\]/);
  });

  it('a Worker that predates those collections still yields a playable review', () => {
    // An empty panel is a correct rendering of "nothing recorded"; refusing the review would
    // deny her the recording over a missing side panel.
    expect(PLAYBACK).toMatch(/\?\? \[\]/);
  });
});

describe('the dashboard is usable on a phone and on a desktop', () => {
  it('it is one column by default and two only when there is room', () => {
    expect(REVIEW_UI).toMatch(/grid gap-4 lg:grid-cols-2/);
  });

  it('the dashboard takes the full width while the list stays a narrow reading column', () => {
    expect(REVIEW_UI).toMatch(/step === 'watch' \? 'w-full' : 'mx-auto w-full max-w-md'/);
  });

  it('the transport targets are real buttons, not hover-only affordances', () => {
    expect(REVIEW_UI).toMatch(/function Transport\(/);
    expect(REVIEW_UI).toMatch(/<Transport onClick=\{reset\}>Reset<\/Transport>/);
  });

  it('scrubbing works by touch — a pointer handler with touch scrolling disabled', () => {
    expect(REVIEW_UI).toMatch(/onPointerDown=\{\(e\) => onSeek\?\.\(fractionFrom\(e\)\)\}/);
    expect(REVIEW_UI).toMatch(/touch-none/);
  });

  /**
   * A scrub target that absorbs a tap and goes nowhere reads as a broken app. Seeking needs a
   * duration, so until one is known the waveform must SAY it cannot seek rather than swallow
   * the gesture — the honest-status rule applied to a control, not just to a status line.
   */
  it('an unseekable waveform says so instead of silently absorbing the tap', () => {
    expect(REVIEW_UI).toMatch(/const seekable = durationSec > 0 && Number\.isFinite\(durationSec\)/);
    expect(REVIEW_UI).toMatch(/onSeek=\{seekable \? seekTo : null\}/);
    expect(REVIEW_UI).toMatch(/Press play to enable seeking/);
    // ...and the transcript's jump buttons are disabled rather than dead.
    expect(REVIEW_UI).toMatch(/disabled=\{!seekable\}/);
  });

  it('the duration is requested before playback, so seeking is available without playing first', () => {
    expect(REVIEW_UI).toMatch(/preload="metadata"/);
    expect(REVIEW_UI).toMatch(/onLoadedMetadata=\{onDuration\}/);
  });
});
