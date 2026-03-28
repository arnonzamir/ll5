// Re-export shared types
export type { Situation } from '@ll5/shared';

export type TimePeriod = 'morning' | 'afternoon' | 'evening' | 'night';
export type DayType = 'weekday' | 'weekend' | 'holiday';
export type EnergyLevel = 'low' | 'medium' | 'high';

export function getTimePeriod(hour: number): TimePeriod {
  if (hour >= 6 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

export function getDayType(dayOfWeek: number): DayType {
  // 0 = Sunday, 6 = Saturday. In Israel, Friday-Saturday is weekend.
  if (dayOfWeek === 5 || dayOfWeek === 6) return 'weekend';
  return 'weekday';
}

export function getSuggestedEnergy(timePeriod: TimePeriod): EnergyLevel {
  switch (timePeriod) {
    case 'morning': return 'high';
    case 'afternoon': return 'medium';
    case 'evening': return 'medium';
    case 'night': return 'low';
  }
}

export function formatTimeUntil(targetTime: string): string {
  const diffMs = new Date(targetTime).getTime() - Date.now();
  if (diffMs < 0) return 'already started';

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'in less than a minute';
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    if (remainingMinutes === 0) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
    return `in ${hours} hour${hours === 1 ? '' : 's'} and ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}`;
  }

  const days = Math.floor(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}
