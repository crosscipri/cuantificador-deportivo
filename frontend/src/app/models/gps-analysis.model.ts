export interface GpsTrackPoint {
  lat: number;
  lon: number;
  time?: Date;
  ele?: number;
}

export interface GpsRunFile {
  filename: string;
  points: GpsTrackPoint[];
  distance_m: number;
}

// Preset colors for each GPS mode
export const GPS_MODE_COLORS = [
  '#3b82f6', // blue
  '#10b981', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#06b6d4', // cyan
];

export interface GpsMode {
  id: string;
  name: string;
  color: string;
  files: GpsRunFile[];
}

export interface GpsModeStats {
  mode_id:        string;
  mode_name:      string;
  color:          string;
  distances:      number[];   // per run in meters
  mean:           number;
  std:            number;
  min:            number;
  max:            number;
  error_mean:     number;     // mean(d_i - ref)
  mae:            number;     // mean(|d_i - ref|)
  mape:           number;     // mean(|d_i - ref| / ref * 100)
  rmse:           number;     // sqrt(mean((d_i - ref)^2))
  cv:             number;     // std/mean * 100
}

export interface GpsTrackAnalysis {
  modes:              GpsMode[];
  stats:              GpsModeStats[];
  reference_distance: number;  // meters (default 1600)
}
