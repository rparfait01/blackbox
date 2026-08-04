import { log } from '@/lib/log';

/**
 * Brief 50 — HIDDEN-MODE VIDEO, GATED ON DEVICE POSTURE.
 *
 * The ruling: Hidden captures video when the screen is off or the device is face-down, audio-only
 * when the screen is on and face-up, re-evaluated continuously. The camera-light rationale holds
 * only when someone is looking at the screen, and Hidden is built for a phone in a pocket.
 *
 * The same ruling requires that if the platform cannot report the gating state RELIABLY, we
 * report that and default to audio-only rather than guess. This module is where that condition is
 * evaluated, and on the current platforms it binds for one of the two gates. Read on.
 *
 * ═══ "SCREEN OFF" IS NOT OBSERVABLE, AND IS ALSO SELF-DEFEATING ══════════════════════════════
 *
 * Three independent reasons, any one of which is sufficient:
 *
 * 1. NO API DISTINGUISHES IT. `document.visibilityState === 'hidden'` is the closest signal and
 *    it conflates screen-locked with app-backgrounded and tab-switched. Gating the camera on it
 *    would start recording because the survivor checked a message.
 *
 * 2. THE APP DELIBERATELY PREVENTS IT. `acquireWakeLock()` runs on every activation in BOTH
 *    modes, holding a screen wake lock for the duration of the event. During a capture the screen
 *    is kept ON on purpose — because, as wake-lock.ts states, the lock "only holds while the page
 *    is visible and is auto-released when backgrounded", and capture does not survive
 *    backgrounding. Screen-off is not a state this app reaches while recording; it is one it
 *    actively fights.
 *
 * 3. IT IS THE STATE WHERE VIDEO CANNOT RECORD. When the page is hidden, iOS and Android both
 *    stop delivering camera frames — the track is muted or ended by the OS. So the condition the
 *    ruling would switch video ON in is precisely the condition in which no video can be captured.
 *
 * Reporting rather than building it, per the ruling's own instruction.
 *
 * ═══ "FACE-DOWN" IS OBSERVABLE — ON ANDROID ═════════════════════════════════════════════════
 *
 * While the screen is on (which, per above, is the whole of an event), the page is visible, JS
 * runs, and the camera works. Face-down is then readable from DeviceMotion's gravity vector.
 *
 *   ANDROID / Chrome — `devicemotion` delivers without a permission prompt. USABLE.
 *   iOS 13+ / Safari — `DeviceMotionEvent.requestPermission()` must be called from a user gesture
 *                      and shows a system dialog. In Hidden mode a dialog IS a facade breach, and
 *                      an unprompted listener receives nothing. NOT USABLE COVERTLY.
 *
 * So this reports its own capability per device and the caller defaults to audio-only when the
 * signal is absent. It never assumes face-up means face-up; it distinguishes "observed face-up"
 * from "cannot observe", and only the first is a reason to stop video.
 */

export type Posture = 'face-down' | 'face-up' | 'unknown';

export interface PostureWatch {
  /** Current reading. `unknown` until a real sample arrives — never a default of convenience. */
  posture: () => Posture;
  /** Can this device report posture at all, without a prompt? */
  available: () => boolean;
  stop: () => void;
}

/**
 * Gravity on Z below this (m/s², pointing INTO the screen) means the screen faces the ground.
 * -8 is roughly 55° past horizontal: comfortably face-down, not a phone lying at a slight angle.
 */
const FACE_DOWN_Z = -8;
/** Hysteresis, so a phone on a vibrating table does not toggle the camera repeatedly. */
const FACE_UP_Z = -5;

/**
 * Watch device posture WITHOUT prompting.
 *
 * Deliberately never calls `DeviceMotionEvent.requestPermission()`. That call requires a user
 * gesture and raises a system dialog — in Hidden mode, a dialog is exactly the tell the covert
 * facade exists to prevent, and Brief 50 §A's rule is absolute: the transition must produce no
 * visible change. A capability we can only obtain by breaking the facade is a capability we do
 * not have.
 */
export function watchPosture(): PostureWatch {
  let current: Posture = 'unknown';
  let sawSample = false;

  const onMotion = (event: DeviceMotionEvent): void => {
    const g = event.accelerationIncludingGravity;
    if (!g || typeof g.z !== 'number') return;
    sawSample = true;
    // Hysteresis band: only cross on a decisive reading.
    if (g.z <= FACE_DOWN_Z) current = 'face-down';
    else if (g.z >= FACE_UP_Z) current = 'face-up';
  };

  let attached = false;
  try {
    if (typeof window !== 'undefined' && 'DeviceMotionEvent' in window) {
      // No requestPermission call. On iOS this listener simply never fires, which `available()`
      // reports honestly as "cannot observe" rather than as "face-up".
      window.addEventListener('devicemotion', onMotion);
      attached = true;
    }
  } catch (error) {
    log.error('posture watch unavailable', error);
  }

  return {
    posture: () => current,
    available: () => attached && sawSample,
    stop: () => {
      if (attached) {
        try {
          window.removeEventListener('devicemotion', onMotion);
        } catch {
          /* teardown must never throw into a capture */
        }
      }
    },
  };
}

/**
 * Should video be running right now, for a COVERT capture?
 *
 * The default is audio-only, and it is a fail-safe rather than a preference: `unknown` posture
 * means we cannot see the phone, and switching the camera on when we cannot tell whether someone
 * is watching the screen is the risk the original camera-light rationale was written about.
 *
 * Audio is the floor and is never a function of this. Nothing here can stop audio.
 */
export function covertVideoWanted(posture: Posture): boolean {
  return posture === 'face-down';
}

/**
 * ═══ EVALUATED ONCE, AT CAPTURE START. RULED, NOT OVERLOOKED. ════════════════════════════════
 *
 * The brief asked for continuous re-evaluation — screen wakes, video stops; screen sleeps, video
 * resumes. Royce ruled against it on the cost, and the cost is structural rather than awkward:
 * switching the camera on or off mid-event means tearing down the MediaRecorder and building a
 * new one. That produces a NEW CONTAINER mid-capture, and three shipped guarantees assume one
 * continuous recorder —
 *
 *   the chunk sequence            (monotonic, and the integrity chain is keyed on it)
 *   the AAD binding               (capture id ‖ chunk index ‖ final flag, Brief 38)
 *   the terminal-chunk marker     (a restart makes a live capture look ended, Brief 38's defect)
 *
 * — so a posture change would be paid for in custody-chain integrity. That trade is not worth
 * video. If the phone is picked up mid-event, the capture keeps whatever it started with.
 *
 * A COROLLARY WORTH STATING, because it decides whether this feature ever fires: the reading must
 * already exist when capture starts. `devicemotion` delivers asynchronously, so a watcher started
 * at trigger time has no sample yet, `available()` is false, posture is `unknown`, and the gate
 * correctly yields audio-only — every time. For the Android face-down case to ever engage, the
 * watch has to be running BEFORE the trigger, from the idle facade. Capture is never delayed to
 * wait for a sample: on the alert path, a recording that starts late is worse than one without
 * video.
 */
