import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', redirectTo: 'sessions', pathMatch: 'full' },
  {
    path: 'upload',
    loadComponent: () =>
      import('./pages/upload/upload.component').then(m => m.UploadComponent),
  },
  {
    path: 'sessions',
    loadComponent: () =>
      import('./pages/sessions/sessions.component').then(m => m.SessionsComponent),
  },
  {
    path: 'sessions/:id',
    loadComponent: () =>
      import('./pages/session-detail/session-detail.component').then(
        m => m.SessionDetailComponent
      ),
  },
  {
    path: 'aggregate',
    loadComponent: () =>
      import('./pages/aggregate/aggregate.component').then(m => m.AggregateComponent),
  },
  { path: '**', redirectTo: 'sessions' },
];
