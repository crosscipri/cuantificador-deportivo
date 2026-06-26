import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', redirectTo: 'devices', pathMatch: 'full' },
  {
    path: 'devices',
    loadComponent: () =>
      import('./pages/devices/devices.component').then(m => m.DevicesComponent),
  },
  {
    path: 'devices/:deviceId',
    loadComponent: () =>
      import('./pages/device-detail/device-detail.component').then(m => m.DeviceDetailComponent),
  },
  {
    path: 'devices/:deviceId/upload',
    loadComponent: () =>
      import('./pages/upload/upload.component').then(m => m.UploadComponent),
  },
  {
    path: 'devices/:deviceId/sessions/:sessionId',
    loadComponent: () =>
      import('./pages/session-detail/session-detail.component').then(m => m.SessionDetailComponent),
  },
  {
    path: 'devices/:deviceId/gps-analysis/track',
    loadComponent: () =>
      import('./pages/gps-track-analysis/gps-track-analysis.component').then(m => m.GpsTrackAnalysisComponent),
  },
  {
    path: 'devices/:deviceId/gps-analysis/urban',
    loadComponent: () =>
      import('./pages/gps-urban-analysis/gps-urban-analysis.component').then(m => m.GpsUrbanAnalysisComponent),
  },
  {
    path: 'devices/:deviceId/gps-analysis/track-ai/:testId',
    loadComponent: () =>
      import('./pages/gps-track-ai/gps-track-ai.component').then(m => m.GpsTrackAiComponent),
  },
  {
    path: 'devices/:deviceId/gps-analysis/urban-ai/:testId',
    loadComponent: () =>
      import('./pages/gps-urban-ai/gps-urban-ai.component').then(m => m.GpsUrbanAiComponent),
  },
  {
    path: 'devices/:deviceId/ai-verdict',
    loadComponent: () =>
      import('./pages/device-ai-verdict/device-ai-verdict.component').then(m => m.DeviceAiVerdictComponent),
  },
  {
    path: 'devices/:deviceId/global-scores',
    loadComponent: () =>
      import('./pages/global-scores/global-scores.component').then(m => m.GlobalScoresComponent),
  },
  {
    path: 'overview',
    loadComponent: () =>
      import('./pages/overview/overview.component').then(m => m.OverviewComponent),
  },
  {
    path: 'devices/:deviceId/nocturnal-hrv',
    loadComponent: () =>
      import('./pages/nocturnal-hrv/nocturnal-hrv.component').then(m => m.NocturnalHrvComponent),
  },
  { path: '**', redirectTo: 'devices' },
];
