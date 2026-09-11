import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { ComparisonResult, ComparisonSelection, ComparisonSession, ComparisonSeries, ComparisonWorkspace, WorkspaceChart, Experiment, SavedComparison, StatisticDefinition } from '../models/comparison.model';

@Injectable({ providedIn: 'root' })
export class ComparisonService {
  constructor(private http: HttpClient) {}
  workspaces(offset=0) { return this.http.get<ComparisonWorkspace[]>('/api/comparison-workspaces', {params:{offset}}); }
  createWorkspace(name:string) { return this.http.post<ComparisonWorkspace>('/api/comparison-workspaces', {name}); }
  workspace(id:string) { return this.http.get<ComparisonWorkspace>(`/api/comparison-workspaces/${id}`); }
  saveWorkspaceChart(id:string,chartId:string|null,selection:ComparisonSelection) {
    return this.http.post<{id:string;result:ComparisonResult;chart:WorkspaceChart}>(`/api/comparison-workspaces/${id}/charts`, {chart_id:chartId,selection});
  }
  definitions() {
    return this.http.get<{version: string; statistics: StatisticDefinition[]; protocols: {id: string; name: string; version: number}[]}>('/api/comparison-definitions');
  }
  sessions(offset = 0, deviceId?: string) {
    let params = new HttpParams().set('offset', offset).set('limit', 100);
    if (deviceId) params = params.set('device_id', deviceId);
    return this.http.get<{items: ComparisonSession[]; has_more: boolean}>('/api/comparison-options/sessions', { params });
  }
  experiments() { return this.http.get<Experiment[]>('/api/experiments'); }
  protocols() { return this.http.get<{id:string;name:string;version:number}[]>('/api/comparison-protocols'); }
  channels(id:string,role:string){return this.http.get<{native_points:number;native_median_step_seconds:number|null;channels:string[];laps:{index:number;start_utc:number|null;end_utc:number|null;distance_m:number|null;duration_seconds:number|null}[];records:unknown[];has_more:boolean}>(`/api/comparison-sessions/${id}/channels`,{params:{role}});}
  updateReferences(id:string,body:{reference_session_id:string;gps_reference_session_id:string|null;hr_quality:string|null;gps_quality:string|null;notes:string}){return this.http.post(`/api/experiments/${id}/references`,body);}
  historicalChart(id:string){return this.http.get<{session_id:string;name:string;time:number[];series:ComparisonSeries[]}>(`/api/comparison-sessions/${id}/historical-chart`);}
  selectedSessions(ids: string[]) {
    return this.http.get<{items: ComparisonSession[]}>('/api/comparison-options/sessions', {params:{session_ids:ids.join(','),limit:100}});
  }
  createExperiment(body: { name: string; session_ids: string[]; reference_session_id: string; gps_reference_session_id: string | null; protocol_id: string | null; protocol_version: number }) {
    return this.http.post<Experiment>('/api/experiments', body);
  }
  list(offset = 0) { return this.http.get<SavedComparison[]>('/api/comparisons', { params: { offset } }); }
  preview(selection: ComparisonSelection) { return this.http.post<ComparisonResult>('/api/comparisons/preview', selection); }
  save(selection: ComparisonSelection) { return this.http.post<{id: string; result: ComparisonResult}>('/api/comparisons', selection); }
  get(id: string) { return this.http.get<{id: string; result: ComparisonResult;selection_request?:ComparisonSelection}>(`/api/comparisons/${id}`); }
  revise(id:string,selection:ComparisonSelection){return this.http.post<{id:string;result:ComparisonResult}>(`/api/comparisons/${id}/revisions`,selection);}
  revisions(id:string){return this.http.get<SavedComparison[]>(`/api/comparisons/${id}/revisions`);}
}
