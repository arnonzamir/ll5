import pkg from 'garmin-connect';
const { GarminConnect } = pkg;

// Types - use any since the package's type exports may not work in ESM
type GarminSleepData = any;
type IActivity = any;
import { logger } from '../../utils/logger.js';

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
    // Create a dummy instance and load tokens
    this.gc = new GarminConnect({ username: 'restored', password: 'restored' });
    this.gc.loadToken(oauth1, oauth2);
    this._connected = true;
  }

  private ensureClient(): InstanceType<typeof GarminConnect> {
    if (!this.gc) throw new Error('GarminClient not initialized — call login() or restoreSession() first');
    return this.gc;
  }

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
      // getHeartRate returns HeartRate type (not exported, so we use unknown)
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

  /**
   * Fetches stress data via the generic GET endpoint.
   * The garmin-connect package does not expose a named method for stress.
   */
  async getStressData(date: string): Promise<unknown> {
    try {
      return await this.ensureClient().get<unknown>(`/wellness-service/wellness/dailyStress/${date}`);
    } catch (err) {
      logger.warn('[GarminClient][getStressData] Failed', { error: String(err), date });
      return null;
    }
  }

  /**
   * Fetches daily summary stats via the generic GET endpoint.
   * Used for steps, distance, calories, active minutes, etc.
   */
  async getDailySummary(date: string): Promise<unknown> {
    try {
      return await this.ensureClient().get<unknown>(`/wellness-service/wellness/dailySummaryChart/${date}`);
    } catch (err) {
      logger.warn('[GarminClient][getDailySummary] Failed', { error: String(err), date });
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
