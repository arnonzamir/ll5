export interface PlaceObservation {
  placeId: string;
  placeName: string;
  count: number;
  lastSeen: string;
}

/**
 * How a network relates to its place (DECISION-021): 'connected' — the phone
 * joins this network there (the classic binding); 'visible' — the network is
 * part of the place's visible-scan fingerprint (it never claims to be the
 * place's own AP). Docs written before the field existed are 'connected'.
 */
export type NetworkBinding = 'connected' | 'visible';

export interface KnownNetwork {
  bssid: string;
  ssid?: string;
  placeObservations: PlaceObservation[];
  manualPlaceId?: string;
  manualPlaceName?: string;
  binding: NetworkBinding;
  label?: string;
  totalObservations: number;
  firstSeen: string;
  lastSeen: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedPlaceForBssid {
  placeId: string;
  placeName: string;
  source: 'manual' | 'auto';
  confidence: number; // 0-1
  observationCount: number;
  totalObservations: number;
  lastSeen: string;
  ssid?: string;
}
