/**
 * Brief 43 §A — REQUEST BOUNDS, STATED IN ONE PLACE.
 *
 * Every limit the API applies to an inbound request lives here as a number with a reason next to
 * it. The alternative is what was here before: no limit anywhere, and an implicit bound set by
 * whatever the runtime happened to tolerate. An unstated limit cannot be reviewed, cannot be
 * tested, and is discovered in production by the request that exceeds it.
 *
 * ═══ TWO DISPOSITIONS, AND THE SPLIT IS THE WHOLE DESIGN ══════════════════════════════════════
 *
 * REJECT — ordinary routes. Settings, admin, org, auth. An oversized body is a bug or an attack,
 *          the caller can retry, and refusing costs a survivor nothing.
 *
 * CLAMP  — the capture path. Chunks, location, classifications, transcripts. These carry evidence
 *          from a device mid-incident. A rejection here is not a retry, it is LOST EVIDENCE: the
 *          phone may be about to be taken, the network may be about to go, and there is no second
 *          chance to upload the moment that mattered. So the bound is applied by TRUNCATING the
 *          batch and accepting the rest, and what was dropped is reported in the response and
 *          recorded — never silently, never as a refusal.
 *
 * This is the standing rule made concrete: on the alert and capture paths, availability outranks
 * everything, and a new control fails open. A bound that refuses a survivor's evidence to save a
 * few kilobytes of memory has the direction of harm exactly backwards.
 *
 * ═══ WHY A DEPTH LIMIT ════════════════════════════════════════════════════════════════════════
 *
 * `JSON.parse` on a deeply nested body is a RangeError, which is catchable — but the parsed value
 * then flows into code that recurses over it (canonicalization, hashing, D1 binding). The depth
 * check bounds what reaches those, rather than trusting each of them to be independently safe.
 */

/**
 * The limits. Every one of these is a stated number with a measured or explained basis; none is a
 * round figure chosen because it looked large.
 */
export const LIMITS = {
  /** Ordinary JSON route. The largest legitimate body on one is an org registration at ~2 KB. */
  jsonBodyBytes: 64 * 1024,

  /**
   * Capture-path JSON (classification and transcript batches). A 60-second transcript batch runs
   * to a few KB; this is three orders of magnitude of headroom so the clamp is a backstop against
   * a runaway client, not something a real device meets.
   */
  captureJsonBodyBytes: 2 * 1024 * 1024,

  /**
   * One media chunk. Measured: chunks in real captures run ~300 KB (the report fixture's are
   * 301,056 bytes). 16 MB is ~50x the observed size — a bound that a real recording cannot reach
   * and a malicious uploader cannot use to exhaust an isolate.
   */
  chunkBytes: 16 * 1024 * 1024,

  /** Items in one capture-path batch. A device sends a handful per tick. */
  batchItems: 500,

  /** A single indexed string (summary text, category label). */
  stringChars: 4_000,

  /** A transcript fragment. Long-form speech, so more generous than the general string bound. */
  transcriptChars: 20_000,

  /** Nesting depth of any parsed body. Nothing this API accepts is nested past ~6. */
  depth: 24,
} as const;

export interface BoundedJson<T> {
  /** Parsed value, or null when the body could not be read as bounded JSON. */
  value: T | null;
  /** Why it is null. `null` when the parse succeeded. */
  refusal: 'too_large' | 'malformed' | 'too_deep' | null;
  /** Bytes actually read. */
  bytes: number;
}

/**
 * Read a JSON body under a byte bound. NEVER THROWS — every failure is a returned value, per §C.
 *
 * The body is read as text first so the byte count is known before parsing; `Content-Length` is
 * consulted as a cheap early reject but never trusted, because it is a client-supplied header and
 * a body can arrive chunked with no length at all.
 */
export async function boundedJson<T>(
  req: { text(): Promise<string>; header(name: string): string | undefined },
  maxBytes: number,
): Promise<BoundedJson<T>> {
  const declared = Number(req.header('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { value: null, refusal: 'too_large', bytes: declared };
  }

  let text: string;
  try {
    text = await req.text();
  } catch {
    return { value: null, refusal: 'malformed', bytes: 0 };
  }

  // The real measurement. A declared length that lied, or was absent, is caught here.
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > maxBytes) return { value: null, refusal: 'too_large', bytes };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Covers both a syntax error and the RangeError from nesting deep enough to exhaust the stack.
    return { value: null, refusal: 'malformed', bytes };
  }

  if (!depthWithin(parsed, LIMITS.depth)) {
    return { value: null, refusal: 'too_deep', bytes };
  }
  return { value: parsed as T, refusal: null, bytes };
}

/**
 * Is `value` nested no deeper than `max`?
 *
 * Iterative on purpose: a recursive depth check on a deeply nested value is itself a stack
 * overflow, which would make the guard the vulnerability it was written to prevent.
 */
export function depthWithin(value: unknown, max: number): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    if (node === null || typeof node !== 'object') continue;
    if (depth > max) return false;
    for (const child of Array.isArray(node) ? node : Object.values(node as Record<string, unknown>)) {
      if (child !== null && typeof child === 'object') stack.push({ node: child, depth: depth + 1 });
    }
  }
  return true;
}

/**
 * Take at most `max` items, and say how many were left behind.
 *
 * The count is returned rather than logged because the CALLER has to tell the client the truth:
 * a response saying `count: 500` when 900 were sent is the dishonest-success shape this codebase
 * has been burned by before (`ok: true, recipients: 0`).
 */
export function clampArray<T>(value: unknown, max: number): { items: T[]; dropped: number } {
  if (!Array.isArray(value)) return { items: [], dropped: 0 };
  if (value.length <= max) return { items: value as T[], dropped: 0 };
  return { items: value.slice(0, max) as T[], dropped: value.length - max };
}

/** Truncate a string to `max` characters. Non-strings become ''. Never throws. */
export function clampString(value: unknown, max: number): { text: string; truncated: boolean } {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

/**
 * §A — which routes are on the CAPTURE PATH and therefore clamp instead of refusing.
 *
 * It lives here, not next to the middleware that uses it, so the guard test asserts the exact
 * value in force rather than a copy of it. The first draft of this pattern spelled `location`
 * where the route is `/locations`; with a trailing `\b` that never matches, so every location
 * upload would have been refused at the ordinary 64 KB bound. A duplicated regex in the test
 * would have agreed with the mistake.
 *
 * `wrapped-keys` is included deliberately. It is small enough that it would rarely meet the
 * ordinary bound, but it carries the wrapped DEKs that let a survivor decrypt HER OWN recordings
 * — refusing it does not lose an upload, it loses access to evidence already stored.
 */
export const CAPTURE_PATH =
  /^\/v1\/events\/[^/]+\/(chunks|classifications|transcripts|locations|wrapped-keys)\b/;

/**
 * ═══ Brief 43 §B — SCHEMA VALIDATION ═════════════════════════════════════════════════════════
 *
 * Bounds say a body is not too big. They say nothing about whether `sequence` is a number or
 * `text` is a string, and every route here reached D1 through a TypeScript cast — which is a
 * compile-time fiction over a runtime value an attacker chose. `as { code?: string }` does not
 * check anything at all.
 *
 * `validate` is the runtime half. It never throws (§C), it returns the parsed value or a list of
 * problems, and the disposition is the caller's — because it has to be. On an ordinary route a
 * schema failure is a 400. On the capture path it is not: a survivor's device sending one
 * malformed field must not lose the other forty records in the batch, so those routes validate
 * PER ITEM and keep what parses.
 */
export interface Validated<T> {
  value: T | null;
  issues: string[];
}

/** A field checker: returns the coerced value, or null to reject the field. */
export type Check<T> = (raw: unknown) => T | null;

export const check = {
  string:
    (max: number): Check<string> =>
    (raw) =>
      typeof raw === 'string' && raw.length <= max ? raw : null,
  /** A string that must be present and non-empty after trimming. */
  requiredString:
    (max: number): Check<string> =>
    (raw) =>
      typeof raw === 'string' && raw.trim().length > 0 && raw.length <= max ? raw : null,
  /** Finite numbers only — NaN and Infinity are JSON-reachable via overflow (see §C). */
  finiteNumber: (): Check<number> => (raw) => (typeof raw === 'number' && Number.isFinite(raw) ? raw : null),
  integerInRange:
    (min: number, max: number): Check<number> =>
    (raw) =>
      typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max ? raw : null,
  boolean: (): Check<boolean> => (raw) => (typeof raw === 'boolean' ? raw : null),
  /** One of a fixed set. An allow-list, never a deny-list. */
  oneOf:
    <T extends string>(allowed: readonly T[]): Check<T> =>
    (raw) =>
      typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : null,
};

/**
 * Validate an object against a field map. Missing OPTIONAL fields are absent from the result;
 * a present-but-wrong field is always an issue, never silently dropped — a body that says
 * `sequence: "3"` has a bug in it, and accepting it quietly is how the bug reaches the evidence.
 */
export function validate<T extends Record<string, unknown>>(
  raw: unknown,
  fields: { [K in keyof T]: { check: Check<T[K]>; required?: boolean } },
): Validated<T> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { value: null, issues: ['body is not an object'] };
  }
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const issues: string[] = [];
  for (const key of Object.keys(fields)) {
    const spec = fields[key as keyof T];
    const present = Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined;
    if (!present) {
      if (spec.required) issues.push(`${key} is required`);
      continue;
    }
    const checked = spec.check(source[key]);
    if (checked === null) {
      issues.push(`${key} is not valid`);
      continue;
    }
    out[key] = checked;
  }
  return issues.length > 0 ? { value: null, issues } : { value: out as T, issues: [] };
}

/**
 * Capture-path variant: validate each item and KEEP WHAT PARSES.
 *
 * The disposition difference is the whole point. Rejecting a 40-record transcript batch because
 * one fragment had a null `text` discards 39 records of a survivor's evidence to punish a client
 * bug. What was rejected is counted and returned so the response can say so.
 */
export function validateEach<T extends Record<string, unknown>>(
  items: readonly unknown[],
  fields: { [K in keyof T]: { check: Check<T[K]>; required?: boolean } },
): { items: T[]; rejected: number } {
  const kept: T[] = [];
  let rejected = 0;
  for (const item of items) {
    const result = validate<T>(item, fields);
    if (result.value === null) rejected += 1;
    else kept.push(result.value);
  }
  return { items: kept, rejected };
}
