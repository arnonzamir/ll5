export interface TopApp {
  package: string;
  appName?: string;
  category?: string;
  foregroundMs?: number;
  opens?: number;
}

/**
 * A battery-light rollup of phone interactivity + app usage for one sync
 * window, derived on-device from a single UsageStatsManager poll. Facts only —
 * the agent deduces wake/active/idle.
 */
export interface DeviceActivity {
  id: string;
  userId: string;
  windowStart: string;
  windowEnd: string;
  screenOnMs?: number;
  unlockCount?: number;
  firstInteraction?: string;
  lastInteraction?: string;
  interactiveNow?: boolean;
  topApps?: TopApp[];
  timestamp: string;
}

export interface DeviceActivityQuery {
  startTime?: string;
  endTime?: string;
  limit?: number;
  offset?: number;
}
