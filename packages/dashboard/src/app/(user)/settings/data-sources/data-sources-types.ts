// Plain types + constants for the data-sources page. Kept out of the
// `"use server"` file because Next.js 15 only allows async functions to be
// exported from server-action modules. Exporting a const object from a
// "use server" file (which we used to do) fails at runtime with:
//   Error: A "use server" file can only export async functions, found object.

export interface DataSourceConfig {
  enabled: boolean;
}

export interface DataSources {
  gps: DataSourceConfig;
  im_capture: DataSourceConfig;
  calendar: DataSourceConfig;
  health: DataSourceConfig;
  whatsapp: DataSourceConfig;
}

export const DEFAULTS: DataSources = {
  gps: { enabled: true },
  im_capture: { enabled: true },
  calendar: { enabled: true },
  health: { enabled: true },
  whatsapp: { enabled: true },
};
