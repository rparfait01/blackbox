import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  CORS_ALLOWED_ORIGINS: string;
  /** PWA origin used to build the contact's magic-link dashboard URL (e.g. https://stillpoint.pages.dev). */
  PWA_ORIGIN?: string;

  // --- Secrets (set via `wrangler secret put`; never in wrangler.toml or source) ---
  /** LINE Messaging API long-lived Channel Access Token (Bearer auth for push). */
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  /** LINE Channel Secret — verifies inbound webhook signatures (HMAC-SHA256). */
  LINE_CHANNEL_SECRET?: string;
  /** Bearer token protecting the pilot-only admin endpoints. */
  ADMIN_TOKEN?: string;
  /** HMAC key signing stateless, read-only magic-link tokens. */
  MAGIC_LINK_SECRET?: string;
}

/** Hono Variables set by the auth middleware after a valid signature. */
export interface Vars {
  eventSecret: string;
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
