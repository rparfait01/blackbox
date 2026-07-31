/**
 * Development-only diagnostic logger.
 *
 * Per the principle there is no analytics or telemetry. These logs never leave
 * the device and are gated behind `import.meta.env.DEV` so production builds
 * emit nothing to the console — keeping the facade quiet in DevTools.
 */
type LogArgs = readonly unknown[];

function debug(...args: LogArgs): void {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console -- dev-only diagnostic logger
    console.debug('[stillpoint]', ...args);
  }
}

function error(...args: LogArgs): void {
  if (import.meta.env.DEV) {
    console.error('[stillpoint]', ...args);
  }
}

export const log = { debug, error };
