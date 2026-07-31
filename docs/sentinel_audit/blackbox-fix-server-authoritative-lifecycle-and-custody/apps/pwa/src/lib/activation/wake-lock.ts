import { log } from '@/lib/log';

/**
 * Screen Wake Lock. Requested on activation to keep the screen on during a
 * foreground session. The Web Wake Lock only holds while the page is visible
 * and is auto-released when backgrounded — so it keeps the screen awake during
 * foreground "meditation" but cannot keep capture alive in the background.
 * That browser limitation is accepted; native background capture is W8.
 */
let sentinel: WakeLockSentinel | null = null;

export async function acquireWakeLock(): Promise<void> {
  try {
    if (!('wakeLock' in navigator)) {
      return;
    }
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch (error) {
    log.error('wake lock request failed', error);
  }
}

export async function releaseWakeLock(): Promise<void> {
  try {
    await sentinel?.release();
  } catch (error) {
    log.error('wake lock release failed', error);
  } finally {
    sentinel = null;
  }
}

export function isWakeLockHeld(): boolean {
  return sentinel !== null;
}
