import { Injectable } from '@angular/core';
import { GpsTrackPoint, GpsRunFile, GpsMode, GpsModeStats, GpsTrackAnalysis } from '../models/gps-analysis.model';

@Injectable({ providedIn: 'root' })
export class GpxParserService {

  parseFile(file: File): Promise<GpsRunFile> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const xml = new DOMParser().parseFromString(
            e.target!.result as string, 'application/xml'
          );
          const parseError = xml.querySelector('parsererror');
          if (parseError) { reject(new Error('XML inválido')); return; }

          const trkpts = Array.from(xml.querySelectorAll('trkpt'));
          if (!trkpts.length) { reject(new Error('Sin puntos GPS en el fichero')); return; }

          const points: GpsTrackPoint[] = trkpts.map(pt => ({
            lat: parseFloat(pt.getAttribute('lat') ?? '0'),
            lon: parseFloat(pt.getAttribute('lon') ?? '0'),
            ele: pt.querySelector('ele') ? parseFloat(pt.querySelector('ele')!.textContent ?? '0') : undefined,
            time: pt.querySelector('time') ? new Date(pt.querySelector('time')!.textContent ?? '') : undefined,
          }));

          const distance_m = this.totalDistance(points);
          resolve({ filename: file.name, points, distance_m });
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('Error al leer el fichero'));
      reader.readAsText(file);
    });
  }

  private haversine(p1: GpsTrackPoint, p2: GpsTrackPoint): number {
    const R = 6371000;
    const toRad = (x: number) => (x * Math.PI) / 180;
    const dLat = toRad(p2.lat - p1.lat);
    const dLon = toRad(p2.lon - p1.lon);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  totalDistance(points: GpsTrackPoint[]): number {
    let d = 0;
    for (let i = 1; i < points.length; i++) d += this.haversine(points[i - 1], points[i]);
    return d;
  }

  computeStats(mode: GpsMode, ref: number): GpsModeStats {
    const distances = mode.files.map(f => f.distance_m);
    const n = distances.length;
    if (n === 0) {
      return {
        mode_id: mode.id, mode_name: mode.name, color: mode.color,
        distances: [], mean: 0, std: 0, min: 0, max: 0,
        error_mean: 0, mae: 0, mape: 0, rmse: 0, cv: 0,
      };
    }

    const mean = distances.reduce((a, b) => a + b, 0) / n;
    const variance = distances.reduce((s, d) => s + (d - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);

    const errors = distances.map(d => d - ref);
    const absErrors = errors.map(Math.abs);

    const error_mean = errors.reduce((a, b) => a + b, 0) / n;
    const mae = absErrors.reduce((a, b) => a + b, 0) / n;
    const mape = absErrors.reduce((a, b) => a + b / ref * 100, 0) / n;
    const rmse = Math.sqrt(distances.reduce((s, d) => s + (d - ref) ** 2, 0) / n);
    const cv = mean > 0 ? (std / mean) * 100 : 0;

    return {
      mode_id: mode.id, mode_name: mode.name, color: mode.color,
      distances,
      mean: Math.round(mean * 10) / 10,
      std: Math.round(std * 10) / 10,
      min: Math.min(...distances),
      max: Math.max(...distances),
      error_mean: Math.round(error_mean * 10) / 10,
      mae: Math.round(mae * 10) / 10,
      mape: Math.round(mape * 100) / 100,
      rmse: Math.round(rmse * 10) / 10,
      cv: Math.round(cv * 100) / 100,
    };
  }

  buildAnalysis(modes: GpsMode[], ref: number): GpsTrackAnalysis {
    const stats = modes
      .filter(m => m.files.length > 0)
      .map(m => this.computeStats(m, ref));
    return { modes: modes.filter(m => m.files.length > 0), stats, reference_distance: ref };
  }
}
