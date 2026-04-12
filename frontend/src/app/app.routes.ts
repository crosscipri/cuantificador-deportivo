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
    path: 'overview',
    loadComponent: () =>
      import('./pages/overview/overview.component').then(m => m.OverviewComponent),
  },
  { path: '**', redirectTo: 'devices' },
];
