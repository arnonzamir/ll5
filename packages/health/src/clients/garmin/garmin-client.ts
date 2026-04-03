import { GarminConnect } from 'garmin-connect';
import type { IOauth1Token, IOauth2Token, IGarminTokens } from 'garmin-connect/dist/garmin/types/index.js';
import type { SleepData as GarminSleepData } from 'garmin-connect/dist/garmin/types/sleep.js';
import type { IActivity } from 'garmin-connect/dist/garmin/types/activity.js';
import { logger } from '../../utils/logger.js';

export class GarminClient {
  private gc: GarminConnect;
  private _connected = false;

  constructor() {
    this.gc = new GarminConnect();
  }

  async login(email: string, password: string): Promise<IGarminTokens> {
    await this.gc.login(email, password);
    this._connected = true;
    return this.gc.exportToken();
  }

  async restoreSession(oauth1: IOauth1Token, oauth2: IOauth2Token): Promise<void> {
    this.gc.loadToken(oauth1, oauth2);
    this._connected = true;
  }

  async getSleepData(date: string): Promise<GarminSleepData | null> {
    try {
      return await this.gc.getSleepData(new Date(date));
    } catch (err) {
      logger.warn('[GarminClient][getSleepData] Failed', { error: String(err), date });
      return null;
    }
  }

  async getHeartRate(date: string): Promise<unknown> {
    try {
      // getHeartRate returns HeartRate type (not exported, so we use unknown)
      return await this.gc.getHeartRate(new Date(date));
    } catch (err) {
      logger.warn('[GarminClient][getHeartRate] Failed', { error: String(err), date });
      return null;
    }
  }

  async getSteps(date: string): Promise<number | null> {
    try {
      return await this.gc.getSteps(new Date(date));
    } catch (err) {
      logger.warn('[GarminClient][getSteps] Failed', { error: String(err), date });
      return null;
    }
  }

  async getActivities(start: number, limit: number): Promise<IActivity[]> {
    try {
      return await this.gc.getActivities(start, limit);
    } catch (err) {
      logger.warn('[GarminClient][getActivities] Failed', { error: String(err), start, limit });
      return [];
    }
  }

  async getDailyWeight(date: string): Promise<unknown> {
    try {
      return await this.gc.getDailyWeightData(new Date(date));
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
      return await this.gc.get<unknown>(`/wellness-service/wellness/dailyStress/${date}`);
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
      return await this.gc.get<unknown>(`/wellness-service/wellness/dailySummaryChart/${date}`);
    } catch (err) {
      logger.warn('[GarminClient][getDailySummary] Failed', { error: String(err), date });
      return null;
    }
  }

  isConnected(): boolean {
    return this._connected;
  }

  getTokens(): IGarminTokens {
    return this.gc.exportToken();
  }
}
