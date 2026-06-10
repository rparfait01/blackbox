import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  CORS_ALLOWED_ORIGINS: string;
}

/** Hono Variables set by the auth middleware after a valid signature. */
export interface Vars {
  eventSecret: string;
}
