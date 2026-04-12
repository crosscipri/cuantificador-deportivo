import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AggregateResult, Session, TrainingType } from '../models/session.model';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly base = '/api';

  constructor(private http: HttpClient) {}

  /** Upload a pair of FIT files and persist the session. */
  uploadSession(
    deviceFile: File,
    referenceFile: File,
    trainingType: string,
    sessionName: string,
    deviceName: string,
    referenceName: string
  ): Observable<Session> {
    const fd = new FormData();
    fd.append('device_file', deviceFile);
    fd.append('reference_file', referenceFile);
    fd.append('training_type', trainingType);
    fd.append('session_name', sessionName);
    fd.append('device_name', deviceName);
    fd.append('reference_name', referenceName);
    return this.http.post<Session>(`${this.base}/sessions`, fd);
  }

  /** List sessions, optionally filtered by training type. */
  listSessions(trainingType?: string): Observable<Session[]> {
    let params = new HttpParams();
    if (trainingType) params = params.set('training_type', trainingType);
    return this.http.get<Session[]>(`${this.base}/sessions`, { params });
  }

  /** Get a single session with full chart data. */
  getSession(id: string): Observable<Session> {
    return this.http.get<Session>(`${this.base}/sessions/${id}`);
  }

  /** Delete a session. */
  deleteSession(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/sessions/${id}`);
  }

  /** Get distinct training types. */
  getTrainingTypes(): Observable<TrainingType[]> {
    return this.http.get<TrainingType[]>(`${this.base}/training-types`);
  }

  /** Generate aggregate analysis for selected sessions. */
  aggregate(sessionIds: string[], trainingType: string): Observable<AggregateResult> {
    return this.http.post<AggregateResult>(`${this.base}/aggregate`, {
      session_ids: sessionIds,
      training_type: trainingType,
    });
  }
}
