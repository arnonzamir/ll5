import pkg from 'garmin-connect';
const { GarminConnect } = pkg;

// Types - use any since the package's type exports may not work in ESM
type GarminSleepData = any;
type IActivity = any;
import { logger } from '../../utils/logger.js';

const API_BASE = 'https://connectapi.garmin.com';

export class GarminClient {
  private gc: InstanceType<typeof GarminConnect> | null = null;
  private _connected = false;

  async login(email: string, password: string): Promise<any> {
    this.gc = new GarminConnect({ username: email, password });
    await this.gc.login();
    this._connected = true;
    return this.ensureClient().exportToken();
  }

  async restoreSession(oauth1: any, oauth2: any): Promise<void> {
    this.gc = new GarminConnect({ username: 'restored', password: 'restored' });
    this.gc.loadToken(oauth1, oauth2);
    this._connected = true;
  }

  private ensureClient(): InstanceType<typeof GarminConnect> {
    if (!this.gc) throw new Error('GarminClient not initialized — call login() or restoreSession() first');
    return this.gc;
  }

  /** Authenticated GET via the internal HttpClient (uses OAuth tokens). */
  private async apiGet(path: string): Promise<unknown> {
    const gc = this.ensureClient();
    return (gc as any).client.get(`${API_BASE}${path}`);
  }

  // --- Named method wrappers (use package's built-in methods) ---

  async getSleepData(date: string): Promise<GarminSleepData | null> {
    try {
      return await this.ensureClient().getSleepData(new Date(date));
    } catch (err) {
      logger.warn('[GarminClient][getSleepData] Failed', { error: String(err), date });
      return null;
    }
  }

  async getHeartRate(date: string): Promise<unknown> {
    try {
      return await this.ensureClient().getHeartRate(new Date(date));
    } catch (err) {
      logger.warn('[GarminClient][getHeartRate] Failed', { error: String(err), date });
      return null;
    }
  }

  async getSteps(date: string): Promise<number | null> {
    try {
      return await this.ensureClient().getSteps(new Date(date));
    } catch (err) {
      logger.warn('[GarminClient][getSteps] Failed', { error: String(err), date });
      return null;
    }
  }

  async getActivities(start: number, limit: number): Promise<IActivity[]> {
    try {
      return await this.ensureClient().getActivities(start, limit);
    } catch (err) {
      logger.warn('[GarminClient][getActivities] Failed', { error: String(err), start, limit });
      return [];
    }
  }

  async getDailyWeight(date: string): Promise<unknown> {
    try {
      return await this.ensureClient().getDailyWeightData(new Date(date));
    } catch (err) {
      logger.warn('[GarminClient][getDailyWeight] Failed', { error: String(err), date });
      return null;
    }
  }

  // --- Direct API endpoints (via authenticated HttpClient) ---

  async getStressData(date: string): Promise<unknown> {
    try {
      return await this.apiGet(`/wellness-service/wellness/dailyStress/${date}`);
    } catch (err) {
      logger.warn('[GarminClient][getStressData] Failed', { error: String(err), date });
      return null;
    }
  }

  async getDailySummary(date: string): Promise<unknown> {
    try {
      return await this.apiGet(`/usersummary-service/usersummary/daily/${date}`);
    } catch (err) {
      // 403 is expected — this endpoint requires displayName, not date
      logger.warn('[GarminClient][getDailySummary] Failed', { error: String(err), date });
      return null;
    }
  }

  async getBodyBattery(): Promise<unknown> {
    try {
      return await this.apiGet('/wellness-service/wellness/bodyBattery/messagingToday');
    } catch (err) {
      logger.warn('[GarminClient][getBodyBattery] Failed', { error: String(err) });
      return null;
    }
  }

  async getHRV(date: string): Promise<unknown> {
    try {
      return await this.apiGet(`/hrv-service/hrv/${date}`);
    } catch (err) {
      logger.warn('[GarminClient][getHRV] Failed', { error: String(err), date });
      return null;
    }
  }

  async getVO2Max(date: string): Promise<unknown> {
    try {
      return await this.apiGet(`/metrics-service/metrics/maxmet/latest/${date}`);
    } catch (err) {
      logger.warn('[GarminClient][getVO2Max] Failed', { error: String(err), date });
      return null;
    }
  }

  async getTrainingReadiness(date: string): Promise<unknown> {
    try {
      return await this.apiGet(`/metrics-service/metrics/trainingreadiness/${date}`);
    } catch (err) {
      logger.warn('[GarminClient][getTrainingReadiness] Failed', { error: String(err), date });
      return null;
    }
  }

  async getRespiration(date: string): Promise<unknown> {
    try {
      return await this.apiGet(`/wellness-service/wellness/daily/respiration/${date}`);
    } catch (err) {
      logger.warn('[GarminClient][getRespiration] Failed', { error: String(err), date });
      return null;
    }
  }

  isConnected(): boolean {
    return this._connected;
  }

  getTokens(): any {
    return this.ensureClient().exportToken();
  }
}
