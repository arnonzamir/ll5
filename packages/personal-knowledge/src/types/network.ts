export interface PlaceObservation {
  placeId: string;
  placeName: string;
  count: number;
  lastSeen: string;
}

export interface KnownNetwork {
  bssid: string;
  ssid?: string;
  placeObservations: PlaceObservation[];
  manualPlaceId?: string;
  manualPlaceName?: string;
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
