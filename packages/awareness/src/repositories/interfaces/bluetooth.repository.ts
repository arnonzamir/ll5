import type {
  BluetoothEvent,
  BluetoothQuery,
  BluetoothConnection,
} from '../../types/bluetooth.js';

export interface BluetoothRepository {
  query(userId: string, query: BluetoothQuery): Promise<BluetoothEvent[]>;
  /**
   * Devices currently connected: within `lookbackHours`, reduce to the latest
   * event per device address and keep those whose latest event is a connect.
   */
  getConnected(userId: string, lookbackHours?: number): Promise<BluetoothConnection[]>;
}
