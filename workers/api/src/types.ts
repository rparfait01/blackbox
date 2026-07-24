import type { D1Database, DurableObjectNamespace, R2Bucket } from '@cloudflare/workers-types';

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  /** Durable Object namespace firing each contact-cascade step at its exact window
   *  (Brief 17). Optional so the worker still runs where the binding is absent. */
  CASCADE_DO?: DurableObjectNamespace;
  /** Per-event WebSocket fan-out for live dashboard push (Brief 16 §4). Optional
   *  so the worker still runs where the binding is absent (polling fallback). */
  EVENT_CHANNEL?: DurableObjectNamespace;
  CORS_ALLOWED_ORIGINS: string;
  /** PWA origin used to build the contact's magic-link dashboard URL (e.g. https://stillpoint.pages.dev). */
  PWA_ORIGIN?: string;
  /** The Worker's own public origin, used to build dashboard links from the cron
   *  (scheduled) context where there is no request URL. */
  WORKER_ORIGIN?: string;
  /** Build stamp (git short SHA) injected at deploy via `--var WORKER_BUILD:<sha>`;
   *  served at GET /version for the deploy-currency pairing (Brief 21). */
  WORKER_BUILD?: string;
  /** Contact Consent §4 gate switch. When 'true', ONLY confirmed contacts are
   *  dispatched to and count toward Armed. Default OFF so the consent infrastructure
   *  (status tracking, confirmation SMS, status UI) can ship as a strict no-op and
   *  be verified live BEFORE the gate is armed — infra first, gate last. Flip via
   *  `wrangler deploy --var CONSENT_GATE_ENFORCED:true` once the pilot is confirmed;
   *  it is a reversible off-switch, not a redeploy. */
  CONSENT_GATE_ENFORCED?: string;
  /** Brief 26 zero-knowledge custody gate. When 'true', the server ACCEPTS and requires
   *  the envelope fields (wrapped keys, plaintext commitments) on the capture path and
   *  the key-management endpoints enforce their invariants. Default OFF so the schema +
   *  endpoints ship dormant and are verified before the client is ever armed. Reversible
   *  off-switch via `wrangler deploy --var ENVELOPE_ENCRYPTION_ENABLED:true`. Even armed,
   *  the client fails open — the server never rejects a plaintext capture for lacking an
   *  envelope while migration is in flight. */
  ENVELOPE_ENCRYPTION_ENABLED?: string;
  /** Deployment security contact for tamper alerts (Fix Brief 2 #C4). For the
   *  family pilot this is the operator/founder. */
  SECURITY_CONTACT_EMAIL?: string;

  // --- Secrets (set via `wrangler secret put`; never in wrangler.toml or source) ---
  /** LINE Messaging API long-lived Channel Access Token (Bearer auth for push). */
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  /** LINE Channel Secret — verifies inbound webhook signatures (HMAC-SHA256). */
  LINE_CHANNEL_SECRET?: string;
  /** StillPoint Official Account public basic id (e.g. "@346hrzaa") for the
   *  QR-connect pairing deep link (Brief 18). Public, not a secret. */
  LINE_OA_BASIC_ID?: string;
  /** Bearer token protecting the pilot-only admin endpoints. */
  ADMIN_TOKEN?: string;
  /** HMAC key signing stateless, read-only magic-link tokens. */
  MAGIC_LINK_SECRET?: string;
  /** HMAC key signing session + guardian-invite tokens. Falls back to MAGIC_LINK_SECRET. */
  SESSION_SECRET?: string;
  /** SendGrid v3 API key (email channel + transactional OTP/invite mail). */
  SENDGRID_API_KEY?: string;
  /** Verified sender address for SendGrid. */
  SENDGRID_FROM_EMAIL?: string;
  /** Sender display name; defaults to "BLACK BOX". */
  SENDGRID_FROM_NAME?: string;
  /** Twilio SMS (default primary channel). Account SID + auth token, plus EITHER
   *  a Messaging Service SID (preferred) or a from-number. Set via secrets. */
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_MESSAGING_SERVICE_SID?: string;
  TWILIO_FROM_NUMBER?: string;
  /** Ed25519 PRIVATE key (PKCS8, base64) signing the integrity chain head +
   *  export manifests (Fix Brief 2 #C2). Set via `wrangler secret put`. */
  INTEGRITY_SIGNING_KEY?: string;
  /** Ed25519 PUBLIC key (SPKI, base64) — published in manifests so the verifier
   *  (recipient/court) can check signatures. Non-secret; safe in vars. */
  INTEGRITY_PUBLIC_KEY?: string;
  /** R2 bucket for the sealed, write-once 36-month custody vault (Fix Brief 2
   *  #C3). Separate from MEDIA (the live capture bucket). */
  VAULT?: import('@cloudflare/workers-types').R2Bucket;
}

/** Hono Variables set by the auth middlewares. */
export interface Vars {
  eventSecret: string;
  /** Set by requireSession after a valid session token. */
  userId: string;
  /** Brief 23: the org this account belongs to, looked up server-side from userId
   *  (NEVER from the token — the session token shape is load-bearing and unextended).
   *  NULL = individual account. Set by requireSession. */
  orgId: string | null;
  /** Brief 23: the account's STAFF role in its org, set by requireOrgRole on the
   *  /v1/org/* portal routes. Absent for individuals and enrolled survivors. */
  orgRole?: 'admin' | 'coordinator';
}

// --- Brief 23 org tenancy rows (see migration 0031_org_tenancy.sql) ---

/** An organization. `lane` is a label only; `orgPubkey` is a reserved forward hook. */
export interface OrganizationRow {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  lane: 'zero_fee' | 'paid';
  orgPubkey: string | null;
  createdAt: number;
  // Brief 24 — license acceptance record (nullable until admin #1 registers).
  licenseAcceptedBy: string | null;
  licenseAcceptedAt: number | null;
  licenseVersion: string | null;
  licenseAcceptancePath: 'click_through' | 'out_of_band' | null;
  // Brief 26 — org key rotation generation (state 8). Dormant until the flag arms.
  orgPubkeyGeneration?: number;
}

// --- Brief 26 zero-knowledge custody rows (see migration 0034_zk_custody.sql) ---

/** A per-chunk wrapped data key. The wrappedDek is a sealed envelope (itself ciphertext
 *  under a public key) — the server can store it and open nothing. */
export interface WrappedKeyRow {
  id: string;
  eventId: string;
  sequence: number;
  recipientType: 'survivor' | 'org' | 'recipient';
  recipientRef: string | null;
  keyGeneration: number;
  algId: string;
  wrappedDek: string;
  createdAt: number;
}

/** A per-seat wrapped copy of the org private key (§5). */
export interface OrgKeyGrantRow {
  id: string;
  orgId: string;
  seatUserId: string;
  keyGeneration: number;
  algId: string;
  wrappedOrgPrivKey: string;
  createdAt: number;
}

/** A signed pre-encryption plaintext commitment (change #1, admissibility). */
export interface PlaintextCommitmentRow {
  eventId: string;
  sequence: number;
  plaintextHash: string;
  createdAt: number;
}

/** A survivor-sealed case file (Brief 27). sealedCaseFile is ciphertext under the
 *  survivor's own public key — no plaintext column exists. */
export interface CaseFileRow {
  id: string;
  userId: string;
  sealedCaseFile: string;
  taxonomyVersion: string;
  createdAt: number;
}

/** A single-use, admin-only registration code bound to one pre-created org (Brief 24).
 *  Distinct from EnrollmentCodeRow — this can only ever create admin #1, never a seat. */
export interface AdminRegistrationCodeRow {
  code: string;
  orgId: string;
  expiresAt: number;
  revoked: number;
  redeemedAt: number | null;
  redeemedByUserId: string | null;
  attemptCount: number;
  lastAttemptAt: number | null;
  reissueReason: string | null;
  createdBy: string | null;
  createdAt: number;
}

/** STAFF membership in an org (admin | coordinator). Enrolled survivors are NOT rows
 *  here — they are tracked by users.orgId alone. */
export interface OrgMemberRow {
  id: string;
  orgId: string;
  userId: string;
  role: 'admin' | 'coordinator';
  status: 'active' | 'revoked';
  createdAt: number;
}

/** An enrollment code binding an account to one org + role. A leaked code grants
 *  membership only, never data access. */
export interface EnrollmentCodeRow {
  code: string;
  orgId: string;
  role: 'survivor' | 'coordinator' | 'admin';
  expiresAt: number | null;
  maxUses: number;
  usedCount: number;
  revoked: number;
  createdBy: string | null;
  createdAt: number;
}

/** A license RECORD (no payment processing). seatsUsed counts enrolled survivors. */
export interface OrgLicenseRow {
  id: string;
  orgId: string;
  seatsTotal: number;
  seatsUsed: number;
  termStart: number | null;
  termEnd: number | null;
  status: 'active' | 'expired';
  createdAt: number;
}

/** A contact is a PERSON (NOT a user — no account, no app install). */
export interface ContactRow {
  id: string;
  userHash: string;
  displayName: string;
  createdAt: number;
}

/** One reach method for a contact. Tried in priority order (lower = first). */
export interface ContactEndpointRow {
  id: string;
  contactId: string;
  channel: string;
  channelIdentifier: string;
  priority: number;
  verifiedAt: number | null;
  createdAt: number;
}
