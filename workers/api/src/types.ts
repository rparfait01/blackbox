import type { D1Database, DurableObjectNamespace, R2Bucket } from '@cloudflare/workers-types';

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  /** Durable Object namespace firing each contact-cascade step at its exact window
   *  (Brief 17). Optional so the worker still runs where the binding is absent. */
  CASCADE_DO?: DurableObjectNamespace;
  CORS_ALLOWED_ORIGINS: string;
  /** PWA origin used to build the contact's magic-link dashboard URL (e.g. https://stillpoint.pages.dev). */
  PWA_ORIGIN?: string;
  /** The Worker's own public origin, used to build dashboard links from the cron
   *  (scheduled) context where there is no request URL. */
  WORKER_ORIGIN?: string;
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
