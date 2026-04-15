import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AggregateResult, Device, Session, SportType, SessionDifficulty, OverviewEntry } from '../models/session.model';

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
}
