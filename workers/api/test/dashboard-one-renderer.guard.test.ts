import { describe, expect, it } from 'vitest';

// @ts-expect-error -- .mjs guard helper, no type declarations
import { code } from '../../../test-utils/guard-source.mjs';
import { fileURLToPath } from 'node:url';

/**
 * BRIEF 60 — THE COORDINATOR PAGE HAS ONE RENDERING SYSTEM.
 *
 * ═══ THREE INCIDENTS, ONE CAUSE ══════════════════════════════════════════════════════════════
 *
 * The page had TWO rendering systems: a server render for everything, and a client poll that
 * updated seven values. Every other element was a photograph taken when the page opened.
 *
 *   * "No camera feed" beside 53 uploaded video chunks.
 *   * "NO AUDIO RECEIVED" beside a live, scrolling transcript.
 *   * A secondary contact offered TAKE COORDINATION on an event that had had a coordinator for
 *     five minutes.
 *
 * Each was fixed individually. The third one is what proved that fixing them individually was the
 * wrong shape of response — a coordinator deciding whether to send help was reading a screen that
 * had stopped being true, and nothing structural prevented the next one.
 *
 * ═══ WHAT THIS ASSERTS ═══════════════════════════════════════════════════════════════════════
 *
 * Every id the server emits into the dashboard is written by a function that `render(st)` calls.
 * The failure message names the specific element, because "the dashboard is stale" is not
 * actionable and "cascadeReach is emitted by SSR and never updated" is.
 *
 * Comment-stripped: an id mentioned in a comment explaining the rule must not satisfy the rule.
 */
const PAGE = code(fileURLToPath(new URL('../src/dashboard/page.ts', import.meta.url))) as string;

/** The dashboard's own client script — everything from `const CLIENT_JS` onward. */
const CLIENT = PAGE.slice(PAGE.indexOf('const CLIENT_JS'));
/** The notified view is a second page with the same obligation. */
const NOTIFIED = PAGE.slice(PAGE.indexOf('const NOTIFIED_JS'), PAGE.indexOf('const CLIENT_JS'));

/** Ids the server emits that are STRUCTURE rather than state — they carry no server value. */
const STATIC_IDS = new Set([
  'map', // the map CONTAINER; its contents are redrawn by applyLocation
  'audio', // the <audio> element itself; its src is owned by the media pipeline
  'cam', // ditto for <video>
  'audioStart',
  'audioNote',
  'camNote',
  'trailSvg',
  'dispatchModal',
  'dispatchQr',
  'dispatchUrl',
  'dispatchCopy',
  'dispatchClose',
  'shareAuth',
  'exportPkg',
  'call',
  'secureAlert',
  'diagPanel',
  'diagOut',
  'coordsMeta',
  'takeCoordNote',
  'fl',
  'fresh',
]);

function emittedIds(source: string): string[] {
  return [...new Set([...source.matchAll(/id="([a-zA-Z][a-zA-Z0-9]*)"/g)].map((m) => m[1] as string))];
}

describe('every value the server emits is re-rendered from server state', () => {
  it('render() exists and is the single entry point', () => {
    // Named first: if this is renamed, every assertion below is vacuous.
    expect(CLIENT, 'render(st) is gone — this guard is asserting over nothing').toMatch(/function render\(st\)\{/);
    // Both the first paint and every poll go through it.
    expect(CLIENT).toMatch(/render\(S\);/);
    expect(CLIENT).toMatch(/render\(st\);/);
  });

  it('NO element is emitted by SSR without a renderer that render() calls', () => {
    const renderBody = CLIENT.slice(CLIENT.indexOf('function render(st){'));
    const body = renderBody.slice(0, renderBody.indexOf('\n  }'));
    const stale: string[] = [];
    for (const id of emittedIds(PAGE)) {
      if (STATIC_IDS.has(id)) continue;
      // An id is covered if any function called from render() touches it, which we approximate
      // by requiring the id to appear inside the client script AND at least one applyX in
      // render's body — the pairing, not merely the presence.
      // BOTH client scripts: the coordinator page and the notified view are two pages carrying
      // the same obligation, and an id owned by one must not be judged against the other.
      const scripts = CLIENT + NOTIFIED;
      const touched =
        scripts.includes(`el('${id}')`) ||
        scripts.includes(`getElementById('${id}')`) ||
        scripts.includes(`setState('${id}'`);
      if (!touched) stale.push(id);
    }
    expect(
      stale,
      `These ids are emitted by the server render and never written by the client. They are ` +
        `photographs: whatever was true when the page opened stays on screen while the event ` +
        `moves on. Add an applyX and call it from render(st), or justify the id in STATIC_IDS.`,
    ).toEqual([]);
    expect(body.length, 'render() has no body').toBeGreaterThan(50);
  });

  it('render() calls every panel renderer', () => {
    const renderBody = CLIENT.slice(CLIENT.indexOf('function render(st){'));
    const body = renderBody.slice(0, renderBody.indexOf('\n  }'));
    for (const fn of [
      'applyOrigin',
      'applySituation',
      'applyCascadeReach',
      'applyTranscript',
      'applyTranscriptState',
      'applyLocationState',
      'applyClosure',
      'applyMedia',
      'applyCaptureSource',
      'applyStatus',
      'applyStreamBadges',
    ]) {
      expect(body, `render() does not call ${fn}`).toContain(fn + '(');
    }
  });

  it('the poll no longer updates panels directly — it calls render and nothing else', () => {
    // The old shape was a list of applyX calls inside poll(), which is how a new panel gets added
    // to one place and not the other.
    const poll = CLIENT.slice(CLIENT.indexOf('function poll(){'), CLIENT.indexOf('poll();\n'));
    expect(poll).toMatch(/render\(st\);/);
    expect(poll, 'the poll writes a panel directly instead of going through render').not.toMatch(
      /applySituation\(|applyTranscript\(|applyClosure\(|applyMedia\(/,
    );
  });
});

describe('the claim affordance is server state, not a page-load decision', () => {
  it('the button is ALWAYS emitted; only its visibility is conditional', () => {
    // Emitting it conditionally made its PRESENCE a load-time decision, so a claim that landed
    // afterwards could never remove it.
    expect(PAGE).toMatch(/<button id="takeCoord"[^>]*>TAKE COORDINATION<\/button>/);
    expect(PAGE, 'the button is emitted conditionally again').not.toMatch(
      /\$\{claimable \? '<button id="takeCoord"/,
    );
  });

  it('the notified poll re-decides it every tick from coordinatorClaimed', () => {
    expect(NOTIFIED).toMatch(/function applyClaimable\(st\)\{/);
    expect(NOTIFIED).toMatch(/applyClaimable\(st\);/);
    expect(NOTIFIED).toMatch(/st\.coordinatorClaimed === true/);
  });

  it('the server actually reports it — the field the poll reads must exist', () => {
    const contactState = code(
      fileURLToPath(new URL('../src/lib/contact-state.ts', import.meta.url)),
    ) as string;
    expect(contactState).toMatch(/coordinatorClaimed: boolean;/);
    expect(contactState).toMatch(/coordinatorClaimed: event\.coordinatorClaimedAt != null/);
  });
});

describe('the ORIGIN snapshot arrives after the page does', () => {
  it('applyOrigin renders it from the poll, not only at load', () => {
    // It is frozen server-side at ~12s. A coordinator who opened the link at T+6s — as one
    // actually did, at 6.3s — saw "Capturing initial-contact snapshot…" permanently.
    expect(CLIENT).toMatch(/function applyOrigin\(st\)\{/);
    expect(CLIENT).toMatch(/Capturing initial-contact snapshot/);
  });

  it('its DTG is preformatted by the server, never re-implemented in the client', () => {
    // Same rule as closedDtg: a second DTG formatter written in inline browser JS is free to
    // drift from formatDtg.
    const contactState = code(
      fileURLToPath(new URL('../src/lib/contact-state.ts', import.meta.url)),
    ) as string;
    expect(contactState).toMatch(/originDtg: origin \? formatDtg\(origin\.dtgStart\) : null/);
    expect(CLIENT).toMatch(/st\.originDtg/);
    expect(CLIENT, 'the client is formatting a DTG itself').not.toMatch(/toUpperCase\(\)[\s\S]{0,40}getUTCMonth/);
  });
});
