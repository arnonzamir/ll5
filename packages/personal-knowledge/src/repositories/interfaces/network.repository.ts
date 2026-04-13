import type { KnownNetwork, ResolvedPlaceForBssid } from '../../types/network.js';

export interface NetworkRepository {
  /** Look up a known network by bssid. Returns null if never observed. */
  getByBssid(userId: string, bssid: string): Promise<KnownNetwork | null>;

  /** List all known networks for a user, sorted by recency. */
  list(userId: string, limit?: number): Promise<KnownNetwork[]>;

  /**
   * Resolve a bssid to a place. Returns null if no confident binding exists.
   * Manual bindings always win. Auto-learned bindings require >= MIN_OBSERVATIONS.
   */
  resolvePlaceByBssid(userId: string, bssid: string): Promise<ResolvedPlaceForBssid | null>;

  /**
   * Manually bind a bssid to a place. Overrides any auto-learned binding.
   * Creates the network record if it doesn't exist yet.
   */
  setManualPlace(
    userId: string,
    bssid: string,
    placeId: string,
    placeName: string,
    label?: string,
  ): Promise<KnownNetwork>;

  /** Remove the manual binding (auto-learned bindings remain). */
  clearManualPlace(userId: string, bssid: string): Promise<boolean>;
}
