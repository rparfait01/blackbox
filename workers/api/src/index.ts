import { Hono } from 'hono';

/**
 * BLACK BOX API Worker — scaffold only (W1).
 *
 * Real routes (activation events, R2 signed uploads, dashboard read tokens,
 * pairing, Durable Object live sessions) arrive in W5+. For now this exposes a
 * single health check so the Worker can be run locally with `wrangler dev`.
 */
const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }, 200));

export default app;
