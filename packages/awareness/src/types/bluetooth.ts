export interface BluetoothEvent {
  id: string;
  userId: string;
  connected: boolean;
  deviceName?: string;
  deviceAddress?: string;
  deviceClass?: string; // car | headset | wearable | phone | computer | other
  timestamp: string;
}

export interface BluetoothQuery {
  startTime?: string;
  endTime?: string;
  limit?: number;
  offset?: number;
}

/** A device whose most recent event (within the lookback) was a connect. */
export interface BluetoothConnection {
  deviceName?: string;
  deviceAddress?: string;
  deviceClass?: string;
  since: string; // timestamp of the connect event
}
