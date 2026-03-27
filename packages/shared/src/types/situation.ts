import type { NotableEvent } from './notable-event.js';

export interface Situation {
  time: string;
  timezone: string;
  timePeriod: 'morning' | 'afternoon' | 'evening' | 'night';
  dayType: 'weekday' | 'weekend' | 'holiday';
  location?: {
    placeName?: string;
    address?: string;
    lat?: number;
    lon?: number;
  };
  nextEvent?: {
    title: string;
    startTime: string;
    location?: string;
  };
  suggestedEnergy?: 'low' | 'medium' | 'high';
  notableEvents: NotableEvent[];
}
