import { describe, expect, it } from 'vitest';

// @ts-expect-error -- .mjs test helper, no type declarations
import { code } from '../../../test-utils/guard-source.mjs';
import { fileURLToPath } from 'node:url';

/**
 * BRIEF 55 §A2 — NO SURFACE CLAIMS A CAPTURE IT HAS NOT OBSERVED.
 *
 * ═══ THE EVENT THIS GUARD EXISTS FOR ═════════════════════════════════════════════════════════
 *
 * A covert activation on production ran for 74 seconds. It dispatched, cascaded, heartbeated,
 * uploaded 8 location fixes and closed cleanly. It stored ZERO capture chunks — the OS had
 * refused the page a microphone — and the coordinator dashboard said, throughout:
 *
 *     "No specific indicators detected yet. Audio + location active."
 *     "...audio and location are recording."
 *     "Capture source: Phone microphone"
 *     "NOT TRANSCRIBED — ... Audio is still recording."
 *
 * Four claims, none of them observed. Every one was reached from `situation.hasSignal`, which is
 * derived from CLASSIFICATION rows, while `state.audio.latestSequence` — the actual chunk
 * observation — sat unread in the same object. The server held the disproof and rendered the
 * claim anyway.
 *
 * ═══ WHY A GUARD AND NOT ONLY A TEST ═════════════════════════════════════════════════════════
 *
 * The failure is not a wrong branch; it is a MISSING one. A behavioural test can only assert the
 * strings that exist today, and the defect class is a new capture claim being written next month
 * with no observation behind it. So this asserts the property structurally: the strings that make
 * a capture claim are reachable only through `audioReceived`.
 */
// COMMENTS STRIPPED (Brief 54 meta-guard): every assertion below is about what the page DOES.
// This file documents its own history heavily, and a guard that matched its own explanation of a
// removed string would pass forever without the string ever having to exist.
const PAGE = code(fileURLToPath(new URL('../src/dashboard/page.ts', import.meta.url))) as string;

describe('§A2 — a capture claim is observed, never asserted', () => {
  it('the observation function exists and reads the stored chunk sequence', () => {
    // The subject. If this is renamed or removed, every assertion below is meaningless, so it is
    // checked FIRST and separately — "I found no violations" and "I found nothing" must not be
    // the same result.
    expect(PAGE).toMatch(/function audioReceived\(state: ContactState\): boolean \{/);
    expect(PAGE).toMatch(/return state\.audio\.latestSequence != null;/);
  });

  it('"Audio + location active" is written ONCE and reached only through the observation', () => {
    // The claim exists as exactly one STRING LITERAL — the CAPTURE_COPY table — and the client
    // renderer is handed that same table rather than a retyped copy. A second literal anywhere is
    // a claim that will outlive its guard, which is how the original defect survived four
    // surfaces.
    const literals = (PAGE.match(/'Audio \+ location active/g) ?? []).length;
    expect(literals, 'the claim was duplicated — one copy will lose its guard').toBe(1);
    expect(PAGE).toMatch(/const CAPTURE_COPY = \{\s*\n\s*received: 'Audio \+ location active\.',/);
    const captureLine = PAGE.slice(PAGE.indexOf('function captureLine('));
    const body = captureLine.slice(0, captureLine.indexOf('\n}'));
    expect(body).toMatch(/if \(audioReceived\(state\)\) \{\s*\n\s*return CAPTURE_COPY\.received;/);
    // The client mirror is EMITTED, so it cannot say something different from the server.
    expect(PAGE).toMatch(/var CAP_COPY=\$\{JSON\.stringify\(CAPTURE_COPY\)\};/);
  });

  it('NO AUDIO RECEIVED is what the coordinator reads instead', () => {
    expect(PAGE).toMatch(/NO AUDIO RECEIVED/);
    // Both lifecycle states are answered. An event that CLOSED without capture is a different
    // sentence from one that is live and blind, and the live one must not read as historical.
    expect(PAGE).toMatch(/Location is arriving; no recording has reached us/);
    expect(PAGE).toMatch(/closed without any recording reaching us/);
  });

  it('the camera panel does not assert audio while denying video', () => {
    // The old copy ended "— audio and location are recording", unconditionally, and it was false
    // on the very event that produced this brief: one denial took both devices.
    const cam = PAGE.slice(PAGE.indexOf('No camera feed.'), PAGE.indexOf('No camera feed.') + 700);
    expect(cam).toMatch(/audioReceived\(state\)/);
    expect(cam).toMatch(/NO AUDIO HAS REACHED US EITHER/);
  });

  it('the capture-source line names hardware only when hardware produced something', () => {
    const src = PAGE.slice(PAGE.indexOf('Capture source'), PAGE.indexOf('Capture source') + 900);
    expect(src).toMatch(/audioReceived\(state\)/);
    expect(src).toMatch(/No capture has reached us from this device/);
  });

  it('the transcription panel no longer asserts that audio is recording', () => {
    // "Audio is still recording" was appended to every transcription-failure message, written by
    // the subsystem least able to check it.
    const claims = (PAGE.match(/Audio is still recording/g) ?? []).length;
    expect(claims, 'the unconditional claim is back in the rendered output').toBe(0);
    expect(PAGE).toMatch(/const audioClause = audioReceived\(state\)/);
  });

  it('the CLIENT renderer asks the same question — it repaints this panel every poll', () => {
    // The client script overwrites the server's HTML on every /state poll. A server-side-only fix
    // is undone three seconds later; that is precisely how the Brief 52 §D threat-badge fix was
    // being lost, which this same brief found and repaired.
    expect(PAGE).toMatch(/function capReceived\(\)\{ return S\.audio && S\.audio\.latestSequence!=null; \}/);
    expect(PAGE).toMatch(/function capLine\(\)\{/);
    expect(PAGE).toMatch(/if\(!capReceived\(\)\)\{ html\+='<div class="muted cap-warn">'\+capLine\(\)/);
  });
});

describe('§D — one vocabulary, emitted rather than retyped', () => {
  it('the label map is imported from shared, not declared here', () => {
    expect(PAGE).toMatch(/import \{[^}]*categoryLabel[^}]*\} from '@blackbox\/shared'/s);
    expect(PAGE, 'a local re-declaration is the divergence this removed').not.toMatch(
      /const CATEGORY_LABEL: Record<string, string> = \{/,
    );
  });

  it('the client copies are GENERATED from the server tables', () => {
    // Both were hand-maintained string literals inside the client script. `SIT_LBL` had drifted
    // in wording risk; the threat badge had actually drifted in BEHAVIOUR — the client knew only
    // high/medium/low and repainted "NOT CLASSIFIED" as a green "UNCLASSIFIED" on every poll.
    expect(PAGE).toMatch(/var SIT_LBL=\$\{JSON\.stringify\(CATEGORY_LABEL\)\};/);
    expect(PAGE).toMatch(/var TH_BADGE=\$\{JSON\.stringify\(THREAT_BADGE\)\};/);
    expect(PAGE, 'the hand-typed client label map is gone').not.toMatch(/var SIT_LBL=\{weapon:/);
    expect(PAGE, 'the hand-typed client threat ternary is gone').not.toMatch(
      /lvl==='critical'\|\|lvl==='high'/,
    );
  });

  it('the threat badge is one table serving both renderers', () => {
    expect(PAGE).toMatch(/const THREAT_BADGE: Record<string, \{ cls: string; label: string \}>/);
    expect(PAGE).toMatch(/unclassified: \{ cls: 'th-unclassified', label: 'NOT CLASSIFIED' \}/);
    expect(PAGE).toMatch(/unknown: \{ cls: 'th-unclassified', label: 'NO AUDIO YET' \}/);
  });
});

describe('§B — a media player is never rendered empty', () => {
  it('the no-MSE fallback drives whichever element is in use, not only <audio>', () => {
    // The branch was audio-only, so on iOS Safari a <video controls> with no src was left on
    // screen reading 00:00 under the words "Live camera". An empty transport reads as "nothing
    // happened", which is the one meaning it must never carry here.
    const fallback = PAGE.slice(PAGE.indexOf('} else if(knownLatest!=null){'));
    const body = fallback.slice(0, fallback.indexOf('} else {'));
    expect(body).toMatch(/media\.controls=false;/);
    expect(body).toMatch(/var isVid=\(media===cam\);/);
    expect(body, 'the fallback must not hard-code the audio element').not.toMatch(/\baudio\.controls=/);
    expect(body).toMatch(/media\.src=api\('\/audio\/full'\)/);
    expect(body).toMatch(/cannot stream live video/);
    expect(body).toMatch(/NOT LIVE — playback only/);
  });

  it('nothing-received is a declared state, not an ellipsis', () => {
    // 'No audio captured yet…' was the whole of what a coordinator saw for an event that would
    // never receive anything. "Not yet" and "never" are different claims.
    expect(PAGE, 'the old wording implied a wait that had no end').not.toMatch(/No audio captured yet…/);
    expect(PAGE).toMatch(/setState\(mediaStateId,'degraded','NO AUDIO RECEIVED'\)/);
    expect(PAGE).toMatch(/do not read this as a quiet room/);
  });
});
