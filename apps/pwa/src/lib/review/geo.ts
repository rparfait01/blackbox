/**
 * The location panel's geometry — coordinates to a drawable path, with NO external service.
 *
 * ─── NO TILES, NO GEOCODER, NO NETWORK ──────────────────────────────────────────────────
 * This module is pure arithmetic over the recorded coordinates. It fetches nothing and names
 * no map provider, deliberately:
 *
 *   - A tile request LEAKS. Asking a tile server for the squares around a survivor's location
 *     tells that server, and anyone logging it, roughly where she was and when she looked. A
 *     map that quietly reports her position to a third party has no place on an evidence
 *     screen.
 *   - A geocoder ASSERTS. "123 Example St" is an interpretation of a coordinate pair, produced
 *     by a service whose answer can change or be wrong. The coordinates are the record; a
 *     street name would be a claim layered on top of it.
 *   - It must work with no signal. She may be reviewing this somewhere with no connection.
 *
 * So the panel draws her own points against a plain graticule and prints the numbers. Less
 * pretty than a street map, and it is the only version that is honest and private.
 */

export interface RecordedPoint {
  timestamp: number;
  lat: number;
  lon: number;
  accuracyM: number | null;
}

export interface PlottedPoint extends RecordedPoint {
  /** 0..1 within the plotted box, x = longitude, y = latitude (already screen-flipped). */
  x: number;
  y: number;
}

export interface LocationPlot {
  points: PlottedPoint[];
  start: RecordedPoint | null;
  end: RecordedPoint | null;
  /** True when she moved beyond the recorded accuracy — see wasTraveling. */
  traveling: boolean;
  /** Straight-line distance from first to last fix, metres. */
  netMetres: number;
  /** Sum of the leg distances, metres — the distance actually covered. */
  pathMetres: number;
  /** Degree span of the plot, so the caller can render a scale honestly. */
  spanLat: number;
  spanLon: number;
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance between two fixes, metres (haversine). */
export function metresBetween(a: RecordedPoint, b: RecordedPoint): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Did she actually move?
 *
 * GPS jitter alone can spread a stationary phone across tens of metres, so a naive
 * first-vs-last comparison would report "traveling" for someone who never left a room — and
 * on an evidence screen that is a false statement about her movements.
 *
 * So movement must exceed the RECORDED ACCURACY of the fixes involved (with a floor, since a
 * device claiming 1 m accuracy indoors is optimistic). Below that, the honest answer is "no",
 * because the record cannot distinguish movement from noise.
 */
export function wasTraveling(points: RecordedPoint[]): boolean {
  if (points.length < 2) return false;
  const first = points[0];
  const last = points[points.length - 1];
  const worstAccuracy = Math.max(first.accuracyM ?? 0, last.accuracyM ?? 0, 25);
  return metresBetween(first, last) > worstAccuracy * 2;
}

/**
 * Project recorded fixes into a unit box for drawing.
 *
 * Equirectangular with a cosine-of-latitude correction on longitude, so a short path is not
 * stretched sideways. Fine at the scale of one incident; it is a plot of her own points, not
 * a survey.
 *
 * A degenerate span (one fix, or every fix identical) centres the points rather than dividing
 * by zero — a single recorded location is a completely normal case and must render.
 */
export function plotLocations(points: RecordedPoint[]): LocationPlot {
  const ordered = [...points].sort((a, b) => a.timestamp - b.timestamp);
  if (ordered.length === 0) {
    return {
      points: [],
      start: null,
      end: null,
      traveling: false,
      netMetres: 0,
      pathMetres: 0,
      spanLat: 0,
      spanLon: 0,
    };
  }

  const lats = ordered.map((p) => p.lat);
  const lons = ordered.map((p) => p.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const midLat = (minLat + maxLat) / 2;

  const lonScale = Math.max(0.15, Math.cos((midLat * Math.PI) / 180));
  const rawSpanLat = maxLat - minLat;
  const rawSpanLon = (maxLon - minLon) * lonScale;
  // One shared span keeps the aspect ratio true, so a north-south path does not render as if
  // it were east-west. The 8% margin keeps end markers off the edge of the box.
  const span = Math.max(rawSpanLat, rawSpanLon) || 1;

  const plotted: PlottedPoint[] = ordered.map((p) => {
    const cx = 0.5 + ((p.lon - (minLon + maxLon) / 2) * lonScale) / span;
    const cy = 0.5 - (p.lat - midLat) / span;
    return { ...p, x: 0.08 + cx * 0.84, y: 0.08 + cy * 0.84 };
  });

  let pathMetres = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    pathMetres += metresBetween(ordered[i - 1], ordered[i]);
  }

  return {
    points: plotted,
    start: ordered[0],
    end: ordered[ordered.length - 1],
    traveling: wasTraveling(ordered),
    netMetres: metresBetween(ordered[0], ordered[ordered.length - 1]),
    pathMetres,
    spanLat: rawSpanLat,
    spanLon: maxLon - minLon,
  };
}

/** Coordinates as text, at ~1 m precision. The numbers are the record, so they are shown. */
export function formatCoord(p: RecordedPoint): string {
  return `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
}

/** A distance a person can judge, without implying precision the fix does not have. */
export function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`;
}
