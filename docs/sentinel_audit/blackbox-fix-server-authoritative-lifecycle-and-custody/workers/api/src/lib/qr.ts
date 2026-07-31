/**
 * QR rendering for the "Share with authorities" dispatch link (Fix Brief 4 G1).
 * Generated server-side from a vetted single-file library — the sensitive
 * dispatch URL is NEVER sent to a third-party QR service. Returns a self-
 * contained dark-on-white SVG the contact dashboard can embed directly.
 */

import qrcode from 'qrcode-generator';

export function qrSvg(text: string): string {
  // typeNumber 0 = auto-size to fit; EC level 'M' (good resilience for a URL).
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  // scalable SVG, modest margin; the dashboard wraps it in a white card.
  return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
}
