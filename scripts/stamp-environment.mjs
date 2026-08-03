#!/usr/bin/env node
/**
 * Brief 35 Fix B §A — stamp a database with its environment name.
 *
 * The stamp lives in the database the Worker's binding points at, so a Worker wired to
 * blackbox-test reads 'staging' no matter what its vars, hostname or deploy command say. This is
 * the one-time operator action that establishes it, and it is a script rather than a curl in a
 * runbook so that the safety check below cannot be skipped by retyping the command from memory.
 *
 * Usage:  node scripts/stamp-environment.mjs --origin=<worker origin> --name=production|staging
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.join('=') || 'true'];
  }),
);

const origin = args.origin;
const name = args.name;
if (!origin || !name || origin === 'true' || name === 'true') {
  console.error('usage: node scripts/stamp-environment.mjs --origin=<url> --name=<production|staging>');
  process.exit(1);
}

/**
 * THE CHECK THAT MATTERS. Stamping a staging database 'production' would re-enable external
 * dispatch from staging — the exact failure this brief exists to close — and stamping production
 * 'staging' would silence every real alert. So the name must agree with the origin, and a
 * disagreement is refused rather than confirmed.
 */
const originLooksStaging = /staging/i.test(origin);
const nameIsProduction = name === 'production';
if (originLooksStaging === nameIsProduction) {
  console.error(
    [
      '',
      `✗ REFUSED: origin ${origin} and name '${name}' disagree.`,
      '  Stamping staging as production re-enables external dispatch from staging.',
      '  Stamping production as staging silences every real alert.',
    ].join('\n'),
  );
  process.exit(1);
}

const token = (() => {
  if (process.env.BBX_ADMIN_TOKEN) return process.env.BBX_ADMIN_TOKEN.trim();
  if (originLooksStaging) {
    try {
      const env = readFileSync(path.join(ROOT, 'workers/api/test/.acceptance.env'), 'utf8');
      return env.match(/^BBX_ADMIN_TOKEN=(.*)$/m)?.[1]?.trim() ?? '';
    } catch {
      return '';
    }
  }
  try {
    return readFileSync(path.join(ROOT, 'workers/admin_token.txt'), 'utf8').trim();
  } catch {
    return '';
  }
})();
if (!token) {
  console.error('no admin credential for that origin');
  process.exit(1);
}

const res = await fetch(`${origin}/v1/admin/environment/stamp`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ name }),
});
const body = await res.json().catch(() => ({}));
console.log(`${res.status} ${JSON.stringify(body)}`);
process.exit(res.ok ? 0 : 1);
