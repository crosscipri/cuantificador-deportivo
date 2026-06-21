import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AggregateResult, AiAnalysis, AiVerdict, Device, Session, SportType, SessionDifficulty, OverviewEntry } from '../models/session.model';
import { GpsTestSummary, GpsTestDetail, GpsAiAnalysis, UrbanTestSummary, UrbanTestDetail, UrbanAiAnalysis, GpsTrackModeScore, GpsUrbanModeScore, GpsStoredScores, GpsOverviewEntry } from '../models/gps-analysis.model';
import { NocturnalHrvSummary, NocturnalHrvDetail, NocturnalHrvAiAnalysis, NocturnalHrvAggregated } from '../models/hrv-analysis.model';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly base = '/api';

  constructor(private http: HttpClient) {}

  // ── Devices ──────────────────────────────────────────────────────────────

  listDevices(): Observable<Device[]> {
    return this.http.get<Device[]>(`${this.base}/devices`);
  }

  getDevice(id: string): Observable<Device> {
    return this.http.get<Device>(`${this.base}/devices/${id}`);
  }

  createDevice(name: string, referenceName: string, description: string): Observable<Device> {
    return this.http.post<Device>(`${this.base}/devices`, {
      name,
      reference_name: referenceName,
      description,
    });
  }

  deleteDevice(id: string): Observable<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>(`${this.base}/devices/${id}`);
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  listDeviceSessions(deviceId: string, trainingType?: string): Observable<Session[]> {
    let params = new HttpParams();
    if (trainingType) params = params.set('training_type', trainingType);
    return this.http.get<Session[]>(`${this.base}/devices/${deviceId}/sessions`, { params });
  }

  uploadSession(
    deviceId: string,
    deviceFile: File,
    referenceFile: File,
    trainingType: string,
    sessionName: string,
    sportType: SportType,
    sessionDifficulty: SessionDifficulty,
  ): Observable<Session> {
    const fd = new FormData();
    fd.append('device_file',        deviceFile);
    fd.append('reference_file',     referenceFile);
    fd.append('training_type',      trainingType);
    fd.append('session_name',       sessionName);
    fd.append('sport_type',         sportType);
    fd.append('session_difficulty', sessionDifficulty);
    return this.http.post<Session>(`${this.base}/devices/${deviceId}/sessions`, fd);
  }

  getSession(id: string): Observable<Session> {
    return this.http.get<Session>(`${this.base}/sessions/${id}`);
  }

  updateSession(id: string, patch: {
    session_name?:       string;
    training_type?:      string;
    sport_type?:         SportType;
    session_difficulty?: SessionDifficulty;
  }): Observable<Session> {
    return this.http.patch<Session>(`${this.base}/sessions/${id}`, patch);
  }

  deleteSession(id: string): Observable<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>(`${this.base}/sessions/${id}`);
  }

  reanalyzeSession(id: string): Observable<Session> {
    return this.http.post<Session>(`${this.base}/sessions/${id}/reanalyze`, {});
  }

  analyzeInterval(id: string, startSec: number, endSec: number): Observable<any> {
    return this.http.post<any>(`${this.base}/sessions/${id}/analyze-interval`, { start_sec: startSec, end_sec: endSec });
  }

  // ── Overview ──────────────────────────────────────────────────────────────

  getOverviewChart(sportType: SportType = 'running'): Observable<{ chart: string; device_count: number; total_sessions: number }> {
    const params = new HttpParams().set('sport_type', sportType);
    return this.http.get<{ chart: string; device_count: number; total_sessions: number }>(
      `${this.base}/overview/chart`, { params }
    );
  }

  getOverviewData(sportType: SportType = 'running'): Observable<OverviewEntry[]> {
    const params = new HttpParams().set('sport_type', sportType);
    return this.http.get<OverviewEntry[]>(`${this.base}/overview/data`, { params });
  }

  // ── Aggregate ─────────────────────────────────────────────────────────────

  aggregate(sessionIds: string[], trainingType: string): Observable<AggregateResult> {
    return this.http.post<AggregateResult>(`${this.base}/aggregate`, {
      session_ids:   sessionIds,
      training_type: trainingType,
    });
  }

  // ── AI Analysis (session) ─────────────────────────────────────────────────

  getSessionAiAnalysis(sessionId: string): Observable<AiAnalysis> {
    return this.http.get<AiAnalysis>(`${this.base}/sessions/${sessionId}/ai-analysis`);
  }

  generateSessionAiAnalysis(sessionId: string, intervalData?: {
    metrics: any; zones: any[]; fc_data: any; lag: number; fcmax: number; duration_seconds: number;
  }): Observable<AiAnalysis> {
    const body = intervalData ? {
      interval_metrics:  intervalData.metrics,
      interval_zones:    intervalData.zones,
      interval_fc_data:  intervalData.fc_data,
      interval_lag:      intervalData.lag,
      interval_fcmax:    intervalData.fcmax,
      interval_duration: intervalData.duration_seconds,
    } : {};
    return this.http.post<AiAnalysis>(`${this.base}/sessions/${sessionId}/ai-analysis`, body);
  }

  // ── AI Verdict (device) ───────────────────────────────────────────────────

  getDeviceAiVerdict(deviceId: string): Observable<AiVerdict> {
    return this.http.get<AiVerdict>(`${this.base}/devices/${deviceId}/ai-verdict`);
  }

  generateDeviceAiVerdict(deviceId: string): Observable<AiVerdict> {
    return this.http.post<AiVerdict>(`${this.base}/devices/${deviceId}/ai-verdict`, {});
  }

  // ── GPS Tests ─────────────────────────────────────────────────────────────

  listGpsTests(deviceId: string): Observable<GpsTestSummary[]> {
    return this.http.get<GpsTestSummary[]>(`${this.base}/devices/${deviceId}/gps-tests`);
  }

  saveGpsTest(deviceId: string, payload: {
    name?: string;
    reference_distance: number;
    modes: { id: string; name: string; color: string; runs: { filename: string; distance_m: number; points: any[] }[] }[];
  }): Observable<GpsTestSummary> {
    return this.http.post<GpsTestSummary>(`${this.base}/devices/${deviceId}/gps-tests`, payload);
  }

  getGpsTest(testId: string): Observable<GpsTestDetail> {
    return this.http.get<GpsTestDetail>(`${this.base}/gps-tests/${testId}`);
  }

  deleteGpsTest(testId: string): Observable<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>(`${this.base}/gps-tests/${testId}`);
  }

  getGpsTestAiAnalysis(testId: string): Observable<GpsAiAnalysis> {
    return this.http.get<GpsAiAnalysis>(`${this.base}/gps-tests/${testId}/ai-analysis`);
  }

  generateGpsTestAiAnalysis(testId: string, modesStats: {
    name: string; rmse: number; p95: number; mean_err: number;
    mape: number; delta_dist: number; sample_hz: number; n_samples: number;
  }[]): Observable<GpsAiAnalysis> {
    return this.http.post<GpsAiAnalysis>(
      `${this.base}/gps-tests/${testId}/ai-analysis`,
      { modes_stats: modesStats },
    );
  }

  // ── Urban Tests ───────────────────────────────────────────────────────────

  listUrbanTests(deviceId: string): Observable<UrbanTestSummary[]> {
    return this.http.get<UrbanTestSummary[]>(`${this.base}/devices/${deviceId}/urban-tests`);
  }

  saveUrbanTest(deviceId: string, payload: {
    name?: string;
    modes: { id: string; name: string; color: string; runs: { filename: string; distance_m: number; points: any[] }[] }[];
  }): Observable<UrbanTestSummary> {
    return this.http.post<UrbanTestSummary>(`${this.base}/devices/${deviceId}/urban-tests`, payload);
  }

  getUrbanTest(testId: string): Observable<UrbanTestDetail> {
    return this.http.get<UrbanTestDetail>(`${this.base}/urban-tests/${testId}`);
  }

  deleteUrbanTest(testId: string): Observable<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>(`${this.base}/urban-tests/${testId}`);
  }

  getUrbanTestAiAnalysis(testId: string): Observable<UrbanAiAnalysis> {
    return this.http.get<UrbanAiAnalysis>(`${this.base}/urban-tests/${testId}/ai-analysis`);
  }

  generateUrbanTestAiAnalysis(testId: string, modesStats: {
    name: string; rmse: number; mape: number; p95: number;
    building_pct: number | null; corner_err: number | null; speed_jitter: number | null;
  }[], refMeters: number): Observable<UrbanAiAnalysis> {
    return this.http.post<UrbanAiAnalysis>(
      `${this.base}/urban-tests/${testId}/ai-analysis`,
      { modes_stats: modesStats, ref_meters: refMeters },
    );
  }

  getOverviewGpsScores(): Observable<GpsOverviewEntry[]> {
    return this.http.get<GpsOverviewEntry[]>(`${this.base}/overview/gps-scores`);
  }

  // ── GPS Scores ────────────────────────────────────────────────────────────

  getGpsScores(deviceId: string): Observable<{
    track?: GpsStoredScores<GpsTrackModeScore>;
    urban?: GpsStoredScores<GpsUrbanModeScore>;
  }> {
    return this.http.get<any>(`${this.base}/devices/${deviceId}/gps-scores`);
  }

  saveGpsScores(deviceId: string, type: 'track' | 'urban', data: GpsStoredScores<GpsTrackModeScore> | GpsStoredScores<GpsUrbanModeScore>): Observable<{ ok: boolean }> {
    return this.http.put<{ ok: boolean }>(`${this.base}/devices/${deviceId}/gps-scores`, { type, data });
  }

  // ── Nocturnal HRV ─────────────────────────────────────────────────────────

  getAggregatedHrvData(deviceId: string): Observable<NocturnalHrvAggregated> {
    return this.http.get<NocturnalHrvAggregated>(`${this.base}/devices/${deviceId}/nocturnal-hrv/aggregated`);
  }

  listNocturnalHrvSessions(deviceId: string): Observable<NocturnalHrvSummary[]> {
    return this.http.get<NocturnalHrvSummary[]>(`${this.base}/devices/${deviceId}/nocturnal-hrv`);
  }

  saveNocturnalHrvSession(deviceId: string, fd: FormData): Observable<NocturnalHrvSummary> {
    return this.http.post<NocturnalHrvSummary>(`${this.base}/devices/${deviceId}/nocturnal-hrv`, fd);
  }

  getNocturnalHrvSession(id: string): Observable<NocturnalHrvDetail> {
    return this.http.get<NocturnalHrvDetail>(`${this.base}/nocturnal-hrv/${id}`);
  }

  deleteNocturnalHrvSession(id: string): Observable<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>(`${this.base}/nocturnal-hrv/${id}`);
  }

  getNocturnalHrvAiAnalysis(id: string): Observable<NocturnalHrvAiAnalysis> {
    return this.http.get<NocturnalHrvAiAnalysis>(`${this.base}/nocturnal-hrv/${id}/ai-analysis`);
  }

  generateNocturnalHrvAiAnalysis(id: string): Observable<NocturnalHrvAiAnalysis> {
    return this.http.post<NocturnalHrvAiAnalysis>(`${this.base}/nocturnal-hrv/${id}/ai-analysis`, {});
  }
}
