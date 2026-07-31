import { z } from 'zod';

/**
 * Shared Zod schemas for BLACK BOX.
 *
 * Placeholder for W1. The real data models (UserConfig, ActivationEvent,
 * Contact, pairing, notification dispatch, etc. — see BLACKBOX_SOFTWARE_SPEC
 * §3) are defined here in W5 when the Worker backend lands. For now this
 * exports the one schema the API Worker's /health endpoint returns, so the
 * contract has a single source of truth from the start.
 */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
