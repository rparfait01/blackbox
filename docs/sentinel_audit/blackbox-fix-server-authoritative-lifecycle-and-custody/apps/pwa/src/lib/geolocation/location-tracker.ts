import { log } from '@/lib/log';

export interface GeoFix {
  timestamp: number;
  lat: number;
  lon: number;
  accuracy: number;
  altitude: number | null;
  speed: number | null;
  heading: number | null;
}

export interface LocationTrackerOptions {
  onFix: (fix: GeoFix) => void;
  onError?: (error: GeolocationPositionError) => void;
}

const STATIONARY_INTERVAL_MS = 5000;
const MOVING_INTERVAL_MS = 1500;
const MOVING_SPEED_THRESHOLD_MPS = 0.7;

/**
 * High-accuracy location tracker. `watchPosition` fires whenever the OS detects
 * movement; we throttle emissions to ~5s while stationary and ~1.5s while
 * moving (movement inferred from reported speed). Permission denial is handled
 * silently. Never throws into the UI.
 */
export class LocationTracker {
  private watchId: number | null = null;
  private lastEmit = 0;
  private readonly options: LocationTrackerOptions;

  constructor(options: LocationTrackerOptions) {
    this.options = options;
  }

  start(): boolean {
    if (this.watchId !== null) {
      return true;
    }
    if (!('geolocation' in navigator)) {
      log.error('geolocation unavailable');
      return false;
    }
    try {
      this.watchId = navigator.geolocation.watchPosition(
        (position) => this.handlePosition(position),
        (error) => {
          log.error('geolocation error', error.message);
          this.options.onError?.(error);
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
      );
      return true;
    } catch (error) {
      log.error('geolocation watch failed', error);
      return false;
    }
  }

  stop(): void {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  private handlePosition(position: GeolocationPosition): void {
    const { coords, timestamp } = position;
    const moving = coords.speed !== null && coords.speed > MOVING_SPEED_THRESHOLD_MPS;
    const interval = moving ? MOVING_INTERVAL_MS : STATIONARY_INTERVAL_MS;

    const now = Date.now();
    if (this.lastEmit !== 0 && now - this.lastEmit < interval) {
      return;
    }
    this.lastEmit = now;

    this.options.onFix({
      timestamp,
      lat: coords.latitude,
      lon: coords.longitude,
      accuracy: coords.accuracy,
      altitude: coords.altitude,
      speed: coords.speed,
      heading: coords.heading,
    });
  }
}
