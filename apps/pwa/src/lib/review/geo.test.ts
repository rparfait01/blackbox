import { describe, expect, it } from 'vitest';

import { formatDistance, metresBetween, plotLocations, wasTraveling, type RecordedPoint } from './geo';

function p(lat: number, lon: number, t = 0, accuracyM: number | null = 10): RecordedPoint {
  return { timestamp: t, lat, lon, accuracyM };
}

describe('distance', () => {
  it('measures a known separation to within a percent', () => {
    // 0.01° of latitude ≈ 1113 m anywhere on Earth.
    expect(metresBetween(p(35.0, 139.0), p(35.01, 139.0))).toBeGreaterThan(1100);
    expect(metresBetween(p(35.0, 139.0), p(35.01, 139.0))).toBeLessThan(1125);
  });

  it('is zero for the same point', () => {
    expect(metresBetween(p(35, 139), p(35, 139))).toBe(0);
  });
});

describe('"traveling" must not be reported for GPS jitter', () => {
  it('a stationary phone with sloppy fixes is NOT traveling', () => {
    // ~11 m of wander with 30 m claimed accuracy: indistinguishable from noise, so the honest
    // answer is no. Reporting movement here would be a false claim about where she went.
    const points = [p(35.0, 139.0, 0, 30), p(35.0001, 139.0, 1_000, 30)];
    expect(wasTraveling(points)).toBe(false);
  });

  it('a real walk IS traveling', () => {
    const points = [p(35.0, 139.0, 0, 10), p(35.005, 139.0, 60_000, 10)]; // ~550 m
    expect(wasTraveling(points)).toBe(true);
  });

  it('an optimistic accuracy claim cannot lower the floor below 25 m', () => {
    // A device claiming 1 m indoors is not to be trusted; 20 m of drift is still noise.
    const points = [p(35.0, 139.0, 0, 1), p(35.00018, 139.0, 1_000, 1)]; // ~20 m
    expect(wasTraveling(points)).toBe(false);
  });

  it('a single fix, or none, is never traveling', () => {
    expect(wasTraveling([p(35, 139)])).toBe(false);
    expect(wasTraveling([])).toBe(false);
  });
});

describe('plotting', () => {
  it('an empty record plots nothing and reports no start', () => {
    const plot = plotLocations([]);
    expect(plot.points).toEqual([]);
    expect(plot.start).toBeNull();
    expect(plot.traveling).toBe(false);
  });

  it('a single fix renders — it is a normal case, not a degenerate one', () => {
    const plot = plotLocations([p(35, 139)]);
    expect(plot.points).toHaveLength(1);
    expect(plot.start).not.toBeNull();
    // Centred, and inside the box.
    expect(plot.points[0].x).toBeCloseTo(0.5, 5);
    expect(plot.points[0].y).toBeCloseTo(0.5, 5);
  });

  it('identical repeated fixes do not divide by zero', () => {
    const plot = plotLocations([p(35, 139, 0), p(35, 139, 1_000)]);
    expect(plot.points.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y))).toBe(true);
  });

  it('every plotted point stays inside the drawable box', () => {
    const plot = plotLocations([p(35.0, 139.0, 0), p(35.02, 139.03, 1_000), p(34.99, 138.98, 2_000)]);
    for (const q of plot.points) {
      expect(q.x).toBeGreaterThanOrEqual(0);
      expect(q.x).toBeLessThanOrEqual(1);
      expect(q.y).toBeGreaterThanOrEqual(0);
      expect(q.y).toBeLessThanOrEqual(1);
    }
  });

  it('orders by time regardless of the order the rows arrived in', () => {
    const plot = plotLocations([p(35.02, 139.0, 5_000), p(35.0, 139.0, 1_000)]);
    expect(plot.points.map((q) => q.timestamp)).toEqual([1_000, 5_000]);
    expect(plot.start?.timestamp).toBe(1_000);
    expect(plot.end?.timestamp).toBe(5_000);
  });

  it('latitude increases UPWARD on screen (y is flipped)', () => {
    const plot = plotLocations([p(35.0, 139.0, 0), p(35.02, 139.0, 1_000)]);
    const [south, north] = plot.points;
    expect(north.y).toBeLessThan(south.y);
  });

  it('path length counts every leg, while straight-line measures only the ends', () => {
    // Out and most of the way back: the distance covered far exceeds the net displacement.
    const plot = plotLocations([p(35.0, 139.0, 0), p(35.01, 139.0, 1_000), p(35.001, 139.0, 2_000)]);
    expect(plot.pathMetres).toBeGreaterThan(plot.netMetres * 3);
  });
});

describe('distance wording', () => {
  it('reads in metres up close and kilometres further out', () => {
    expect(formatDistance(12.4)).toBe('12 m');
    expect(formatDistance(999)).toBe('999 m');
    expect(formatDistance(1_500)).toBe('1.5 km');
    expect(formatDistance(42_000)).toBe('42 km');
  });
});
