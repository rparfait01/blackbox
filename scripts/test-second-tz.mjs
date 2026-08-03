#!/usr/bin/env node
/**
 * Brief 43 §D — RUN THE SUITE IN A SECOND TIMEZONE.
 *
 * "The environment is a test input. A suite that only ever runs in one of them cannot catch a bug
 * in the others." This is that rule made mechanical, because it is not a thing anyone remembers.
 *
 * WHY IT EARNED ITS PLACE, measured rather than argued. Replacing `getUTCDate` with `getDate` in
 * the evidence label — a real host-zone dependency, exactly the bug the label must not have —
 * produced ONE failure under this machine's Asia/Tokyo and FIVE under America/Los_Angeles. Four
 * behavioural tests were blind in Tokyo, including the one asserting the rendered label. The
 * reason is arithmetic: 05:32Z is 14:32 the same day in Tokyo, so the local and UTC date getters
 * agree, and every assertion about the date passed while reading the wrong one.
 *
 * THE SECOND ZONE IS CHOSEN, NOT ARBITRARY. Los Angeles is 16-17 hours from Tokyo and on the far
 * side of a date boundary for the instants this suite uses, so a date component read from the
 * wrong clock lands on a different day rather than the same one. A second zone an hour away would
 * satisfy the letter of the rule and catch nothing.
 *
 * `TZ` is set here rather than in the shell command because Windows shells do not pass it through
 * to a Node process the way a POSIX shell does — `TZ=x pnpm test` silently runs in the host zone,
 * which would make this whole pass a no-op that reports success.
 *
 * Usage:  node scripts/test-second-tz.mjs [zone]
 */
import { spawnSync } from 'node:child_process';

const zone = process.argv[2] ?? 'America/Los_Angeles';

// Prove the override took before trusting anything the run reports. A silent no-op here would be
// worse than not running at all: it would report a second-zone pass that never happened.
const probe = spawnSync(
  process.execPath,
  ['-e', 'console.log(Intl.DateTimeFormat().resolvedOptions().timeZone, new Date().getTimezoneOffset())'],
  { env: { ...process.env, TZ: zone }, encoding: 'utf8' },
);
const [seen, offset] = (probe.stdout ?? '').trim().split(' ');
if (seen !== zone) {
  console.error(`✗ TZ override did not take: asked for ${zone}, the runtime reports ${seen || '(nothing)'}.`);
  console.error('  A second-zone pass that silently runs in the host zone is a pass that never happened.');
  process.exit(1);
}

const hostOffset = new Date().getTimezoneOffset();
console.log(`=== suite under ${zone} (offset ${offset}); host is ${Intl.DateTimeFormat().resolvedOptions().timeZone} (${hostOffset}) ===`);
if (Math.abs(Number(offset) - hostOffset) < 600) {
  console.error(
    `✗ ${zone} is only ${Math.abs(Number(offset) - hostOffset)} minutes from the host zone.\n` +
      '  The second zone must sit across a date boundary or it catches nothing — pick one further away.',
  );
  process.exit(1);
}

const run = spawnSync('pnpm', ['-r', 'test'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, TZ: zone },
});
process.exit(run.status ?? 1);
