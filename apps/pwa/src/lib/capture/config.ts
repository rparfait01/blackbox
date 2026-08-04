import type { ActivationSource, CaptureMode } from '@/lib/storage/types';

/**
 * Default capture mode used as a fallback. Audio-only is the safe default; the
 * effective mode is resolved per activation by `captureModeForSource`.
 */
export const DEFAULT_CAPTURE_MODE: CaptureMode = 'audio';

/**
 * Capture mode. AUDIO + VIDEO FOR EVERY SOURCE — Hidden included, unconditionally.
 *
 * ═══ THE CAMERA-LIGHT RATIONALE IS VOID (correction to Brief 50 §D) ═════════════════════════
 *
 * Covert activation used to keep the camera off "so nothing on the phone betrays that capture is
 * running". That reasoning does not survive contact with who is holding the phone: the indicator
 * is on the SURVIVOR'S OWN device, she triggered the alert, and she knows capture is running.
 * There is nobody it betrays.
 *
 * The video is not for her screen. It is for the support contact's dashboard — the person being
 * asked to decide whether to come. Withholding it in the mode built for a phone in a pocket
 * removed evidence from exactly the situation that most needs it, and bought nothing.
 *
 * An intermediate posture gate — video only when the device was face-down — is also removed. It
 * was a smaller version of the same mistake, and it added a DeviceMotion dependency, an iOS
 * permission prompt that would itself have been a facade breach, and a state machine, all to
 * withhold evidence from a support contact.
 *
 * ═══ WHAT DOES NOT CHANGE ══════════════════════════════════════════════════════════════════
 *
 * The facade rule, which is absolute and untouched: in Hidden the UI shows NOTHING. No preview,
 * no indicator, no recording chrome. Capture is a background fact; the facade does not move. This
 * function chooses what is RECORDED, never what is RENDERED — those are different layers and the
 * covert no-regression guards cover the second.
 *
 * ═══ WHEN THE PLATFORM REFUSES ═════════════════════════════════════════════════════════════
 *
 * We always ASK for video. If a platform refuses a camera track in some state, the acquisition
 * ladder in media-capture.ts degrades to audio and the degradation is DECLARED (Brief 36 §D).
 * Never decline to request it — a capability withheld by us is indistinguishable, in the record,
 * from one the platform denied, and only one of those is true.
 */
export function captureModeForSource(_source: ActivationSource): CaptureMode {
  return 'audio-video';
}

/** MediaRecorder chunk interval. One chunk per second. */
export const CHUNK_INTERVAL_MS = 1000;
