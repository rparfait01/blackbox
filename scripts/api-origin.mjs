/**
 * Brief 35 §A/§B — the ONE definition of a valid production API origin.
 *
 * THE DEFECT THIS CLOSES. `API_BASE_URL` fell back to an empty string when
 * `VITE_API_BASE_URL` was absent, and the whole upload/event/heartbeat pipeline
 * quietly turned itself off. A production build with no API origin is not a degraded
 * build — it is a build in which the ALERT PATH DOES NOT EXIST. Activation still
 * starts local capture and still shows an active alert, so the failure is invisible
 * from the device: no event is created, no contact is notified, no evidence leaves
 * the phone. Nothing checked, and build-id currency reported green.
 *
 * So the rules live HERE, in one plain module with no dependencies, and every gate
 * that needs them imports this one:
 *
 *   - apps/pwa/vite.config.ts — fails the production BUILD (non-zero exit).
 *   - scripts/deploy.mjs      — validates BEFORE building, and reports the origin.
 *   - scripts/canary.mjs      — validates the target before the round trip.
 *   - scripts/verify-hardening.mjs — proves the failure paths without a real deploy.
 *
 * Deploy/build tooling only — no application code. The PWA re-states the same rule at
 * runtime in src/lib/env.ts, which is defence in depth, not the primary gate.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** The build-time variable the PWA reads. Named once so no gate can typo it. */
export const API_ORIGIN_VAR = 'VITE_API_BASE_URL';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS_FILE = path.join(ROOT, 'config/deploy-targets.json');

/**
 * Hosts that can never be a production API origin. A build pointed at any of these
 * reaches nothing from a survivor's phone, which is the same outcome as an empty
 * origin — it just fails somewhere the deploy would not notice.
 */
function isNonPublicHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0.0.0.0' || host === '::') return true;
  // Reserved / non-routable suffixes (RFC 2606 + mDNS + common private zones).
  if (/\.(local|internal|localdomain|test|example|invalid|home\.arpa)$/.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 0 || a === 10) return true; // loopback / this-host / private
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
  return false;
}

/**
 * Validate a production API origin. Returns `{ ok: true, origin }` with the
 * normalised origin, or `{ ok: false, reason }` with a message that NAMES the
 * problem — a gate that fails without saying which variable is wrong just moves the
 * silence somewhere else.
 *
 * Deliberately strict: non-empty, parses as a URL, scheme is https:, host is
 * routable. There is no "warn and continue" return.
 */
export function validateApiOrigin(value) {
  if (value == null || String(value).trim() === '') {
    return { ok: false, reason: `${API_ORIGIN_VAR} is missing or empty` };
  }
  const raw = String(value).trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `${API_ORIGIN_VAR} is not a URL: '${raw}'` };
  }
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      reason: `${API_ORIGIN_VAR} must be https: — got '${url.protocol}//' in '${raw}'`,
    };
  }
  if (!url.hostname) {
    return { ok: false, reason: `${API_ORIGIN_VAR} has no host: '${raw}'` };
  }
  if (isNonPublicHost(url.hostname)) {
    return {
      ok: false,
      reason: `${API_ORIGIN_VAR} points at a non-routable host ('${url.hostname}') — a phone cannot reach it: '${raw}'`,
    };
  }
  // Normalise: origin only, no trailing slash. The PWA concatenates paths onto it.
  return { ok: true, origin: url.origin };
}

/**
 * Validate or DIE. Used by build/deploy gates where the only correct response to a
 * bad origin is a non-zero exit before anything is published.
 */
export function assertApiOrigin(value, context) {
  const result = validateApiOrigin(value);
  if (!result.ok) {
    const where = context ? ` (${context})` : '';
    throw new Error(
      `BUILD REFUSED${where}: ${result.reason}.\n` +
        `  A production build with no API origin has NO ALERT PATH: activation would start\n` +
        `  local capture and show an active alert while creating no event, notifying no\n` +
        `  contact, and uploading nothing. That build must never be published.\n` +
        `  Set it in config/deploy-targets.json (tracked) or, for local dev only, apps/pwa/.env.`,
    );
  }
  return result.origin;
}

/** Read the tracked per-environment deploy config (§B). Throws if it is unusable. */
export function loadDeployTargets() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(TARGETS_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`config/deploy-targets.json is missing or unreadable: ${error.message}`);
  }
  return parsed;
}

/**
 * The validated config for one environment ('production' | 'staging'). The origin is
 * checked HERE, at read time, so a bad value in tracked config fails the same way a
 * missing one does — before the build, not after the publish.
 */
export function deployTarget(environment) {
  const targets = loadDeployTargets();
  const target = targets[environment];
  if (!target) {
    throw new Error(
      `config/deploy-targets.json has no '${environment}' entry (found: ${Object.keys(targets)
        .filter((k) => !k.startsWith('$'))
        .join(', ')})`,
    );
  }
  const apiOrigin = assertApiOrigin(target.apiOrigin, `config/deploy-targets.json → ${environment}.apiOrigin`);
  return { ...target, environment, apiOrigin };
}
