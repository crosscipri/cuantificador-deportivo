/// <reference path="./leaflet.d.ts" />
import { UiIconComponent } from './ui-icon.component';
import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, Input, OnChanges, OnDestroy, PLATFORM_ID, ViewChild, inject } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import type { Map as VectorMap, StyleSpecification } from 'maplibre-gl';
import { CHART_REFERENCE, TRACK_COLORS } from './chart-colors';

interface Track {
  name: string;
  role: string;
  segments: { lat: number; lon: number }[][];
}

const EMPTY_STYLE: StyleSpecification = {
  version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef1ed' } }],
};

@Component({
  selector: 'app-review-urban-map',
  standalone: true,
  imports: [UiIconComponent, CommonModule],
  template: `
    <div class="map-shell" [attr.data-zoom]="zoom" [attr.data-renderer]="fallback ? 'leaflet' : 'vector'">
      <div #map class="urban-map" aria-label="Mapa interactivo de recorridos GPS"></div>
      <div class="map-views" role="group" aria-label="Encuadre del mapa" *ngIf="ready">
        <button type="button" (click)="frame(true)" [attr.aria-pressed]="view==='detail'">Detalle</button>
        <button type="button" (click)="frame(false)" [attr.aria-pressed]="view==='route'">Ruta completa</button>
      </div>
      <div class="map-zoom" role="group" aria-label="Zoom del mapa" *ngIf="ready">
        <button type="button" (click)="changeZoom(.5)" [disabled]="zoom>=19" aria-label="Acercar mapa" title="Acercar mapa"><svg appIcon="plus"></svg></button>
        <button type="button" (click)="changeZoom(-.5)" [disabled]="zoom<=2" aria-label="Alejar mapa" title="Alejar mapa"><svg appIcon="minus"></svg></button>
      </div>
      <p class="map-message" *ngIf="!ready && !error" role="status">Cargando mapa…</p>
      <p class="map-message" *ngIf="error" role="alert">{{error}} <button type="button" (click)="initialize()">Reintentar</button></p>
    </div>
    <p class="map-note" *ngIf="baseUnavailable" role="status">El fondo del mapa no está disponible. Los recorridos siguen visibles.</p>
    <div class="map-legend" role="group" aria-label="Recorridos visibles" *ngIf="ready">
      <button type="button" *ngFor="let track of tracks; let i=index" (click)="toggle(i)" [attr.aria-pressed]="visible[i]" [style.--route-color]="color(i)">
        <span class="route-swatch" [class.reference]="track.role==='reference'" aria-hidden="true"></span>
        <span class="route-label"><strong>{{track.name}}</strong><small>{{track.role==='reference' ? 'Referencia' : 'Dispositivo'}}</small></span>
        <span class="route-check" aria-hidden="true"><svg [appIcon]="visible[i] ? 'check' : 'plus'"></svg></span>
      </button>
    </div>
    <p class="map-help" *ngIf="ready">Pulsa un recorrido para mostrarlo u ocultarlo. {{fallback ? 'Arrastra para explorar.' : 'Arrastra para explorar; en móvil, usa dos dedos.'}}</p>
  `,
  styles: [`
    :host{display:block;min-width:0}
    .map-shell{position:relative;isolation:isolate;border:1px solid #e1e6e9;border-radius:16px;overflow:hidden;background:#eef1ed}
    .urban-map{height:520px;width:100%;font-family:var(--font-body,Arial,sans-serif)}
    .map-views,.map-zoom{position:absolute;z-index:500;background:#fff;border:1px solid #dfe5e9;box-shadow:0 3px 14px #24343f22;overflow:hidden}
    .map-views{top:14px;left:14px;display:flex;padding:4px;gap:3px;border-radius:28px}
    button{font:inherit;cursor:pointer;color:#334155}
    button:focus-visible{outline:3px solid #276da8;outline-offset:-3px}
    .map-views button{border:0;background:transparent;padding:10px 14px;border-radius:22px;font-size:12px;font-weight:500}
    .map-views button[aria-pressed=true]{background:#edf5fe;color:#195b97}
    .map-zoom{right:14px;bottom:46px;display:grid;border-radius:12px}
    .map-zoom button{display:grid;place-items:center;width:44px;height:44px;padding:0;border:0;background:#fff;font:26px/1 Arial,sans-serif}
    .map-zoom button+button{border-top:1px solid #e4e9ed}
    .map-zoom button:hover{background:#edf5fe}.map-zoom button:disabled{color:#a2aab4;cursor:default}
    .map-message{position:absolute;z-index:501;top:42%;left:16px;right:16px;margin:0;padding:16px;border-radius:12px;background:#ffffffed;text-align:center;font-size:13px;box-shadow:0 3px 14px #24343f16}
    .map-message button{border:1px solid #ccd5dc;border-radius:6px;background:#fff;padding:8px;margin-top:8px}
    .map-legend{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 0}
    .map-legend button{display:flex;flex:1 1 190px;min-width:0;align-items:center;gap:10px;padding:11px 12px;text-align:left;border:1px solid #dce4eb;border-radius:12px;background:#f7faff}
    .map-legend button[aria-pressed=false]{background:#fff;color:#6b7280;border-style:dashed}
    .route-label{display:grid;gap:4px;flex:1;min-width:0}.route-label strong{font-size:12px;font-weight:500;overflow-wrap:anywhere}.route-label small{font-size:10px;color:#64748b}
    .route-swatch{width:24px;flex:0 0 24px;border-top:3px solid var(--route-color)}.route-swatch.reference{border-top-style:dashed}
    [aria-pressed=false] .route-swatch{opacity:.35}.route-check{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:#e2edfa;color:#195b97;font:12px/18px Arial;text-align:center}
    [aria-pressed=false] .route-check{background:#eef1f4;color:#64748b}
    .map-help,.map-note{font-size:11px;line-height:1.6;color:#586575;margin:12px 0 0}
    :host ::ng-deep .urban-map .maplibregl-ctrl-attrib,:host ::ng-deep .urban-map .leaflet-control-attribution{background:#ffffffeb;font-size:9px;color:#44515b;padding:2px 6px}
    :host ::ng-deep .urban-map .maplibregl-ctrl-scale,:host ::ng-deep .urban-map .leaflet-control-scale-line{background:#ffffffcf;border-color:#6b7885;color:#334155;font:10px var(--font-body,Arial,sans-serif)}
    :host ::ng-deep .urban-map .leaflet-tile-pane{filter:saturate(.5) brightness(1.05)}
    @container review (max-width:600px){.urban-map{height:400px}.map-views{top:10px;left:10px}.map-views button{padding:9px 11px}.map-zoom{right:10px;bottom:56px}.map-legend button{flex-basis:100%}}
  `],
})
export class ReviewUrbanMapComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() tracks: Track[] = [];
  @ViewChild('map') element?: ElementRef<HTMLElement>;
  private platform = inject(PLATFORM_ID);
  private cd = inject(ChangeDetectorRef);
  private map?: VectorMap;
  private raster: any;
  private rasterGroups: any[] = [];
  private resize?: ResizeObserver;
  private abort?: AbortController;
  private generation = 0;
  private bounds?: [[number, number], [number, number]];
  ready = false;
  fallback = false;
  error = '';
  baseUnavailable = false;
  visible: boolean[] = [];
  zoom = 0;
  view: 'detail' | 'route' | 'custom' = 'route';

  color(index: number): string {
    return this.tracks[index].role === 'reference' ? CHART_REFERENCE : TRACK_COLORS[this.tracks.slice(0, index).filter(t => t.role !== 'reference').length % TRACK_COLORS.length];
  }
  ngAfterViewInit(): void { if (isPlatformBrowser(this.platform)) void this.initialize(); }
  ngOnChanges(): void { if (this.element && isPlatformBrowser(this.platform)) void this.initialize(); }

  async initialize(): Promise<void> {
    this.dispose();
    const generation = this.generation;
    this.ready = false; this.error = ''; this.baseUnavailable = false; this.fallback = false;
    this.visible = this.tracks.map(() => true);
    const coordinates = this.tracks.flatMap(t => t.segments.flatMap(s => s.map(p => [p.lon, p.lat] as [number, number])));
    if (!coordinates.length) { this.error = 'No hay coordenadas disponibles para este recorrido.'; return; }
    this.bounds = coordinates.reduce<[[number, number], [number, number]]>((b, p) => [[Math.min(b[0][0], p[0]), Math.min(b[0][1], p[1])], [Math.max(b[1][0], p[0]), Math.max(b[1][1], p[1])]], [[180, 90], [-180, -90]]);
    try {
      const gl = await import('maplibre-gl');
      if (generation !== this.generation) return;
      // Workers stay local, versioned and separate from the SSR bundle in both apps.
      gl.setWorkerUrl(new URL('assets/maplibre/6.11.2/maplibre-gl-worker.mjs', document.baseURI).href);
      let style = EMPTY_STYLE;
      const controller = this.abort = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch('https://tiles.openfreemap.org/styles/bright', { signal: controller.signal, credentials: 'omit' });
        if (!response.ok) throw new Error('Mapa no disponible');
        style = await response.json();
        // Keep street names, but remove the dense POI/one-way icon layers.
        style.layers = style.layers.filter(l => !/^(poi_|road_oneway|highway-shield|road_shield)/.test(l.id));
        const background = style.layers.find(l => l.id === 'background');
        if (background?.type === 'background') background.paint = { 'background-color': '#f2f4f3' };
        const buildings = style.layers.find(l => l.id === 'building');
        if (buildings?.type === 'fill') buildings.paint = { 'fill-color': '#e4e8e8', 'fill-opacity': .72 };
      } catch { this.baseUnavailable = true; }
      finally { clearTimeout(timer); }
      if (generation !== this.generation) return;
      try {
        this.map = new gl.Map({
          container: this.element!.nativeElement, style, bounds: this.bounds,
          fitBoundsOptions: { padding: 30, maxZoom: 18 }, minZoom: 2, maxZoom: 19,
          scrollZoom: false, dragRotate: false, pitchWithRotate: false,
          touchPitch: false, cooperativeGestures: true, renderWorldCopies: false,
          locale: {
            'CooperativeGesturesHandler.MobileHelpText': 'Usa dos dedos para mover el mapa',
            'CooperativeGesturesHandler.WindowsHelpText': 'Usa los botones + y − para acercar o alejar',
            'CooperativeGesturesHandler.MacHelpText': 'Usa los botones + y − para acercar o alejar',
            'Map.Title': 'Mapa interactivo de recorridos GPS',
          },
          attributionControl: { compact: false },
        });
      } catch {
        // Keep the comparison usable in browsers without WebGL.
        this.element!.nativeElement.replaceChildren();
        await this.initializeRaster(generation);
        return;
      }
      const map = this.map;
      map.touchZoomRotate.disableRotation();
      map.addControl(new gl.ScaleControl({ unit: 'metric', maxWidth: 90 }), 'bottom-left');
      map.on('error', event => {
        if (generation !== this.generation) return;
        if ((event as { sourceId?: string }).sourceId?.startsWith('review-route-')) this.error = 'No se pudieron dibujar los recorridos.';
        else this.baseUnavailable = true;
        this.cd.markForCheck();
      });
      map.on('style.load', () => {
        // Separate GeoJSON LineStrings preserve every recorded gap and coordinate.
        this.tracks.forEach((track, i) => {
          map.addSource(`review-route-${i}`, { type: 'geojson', tolerance: 0, data: {
            type: 'FeatureCollection', features: track.segments.filter(s => s.length > 0).map(segment => ({
              type: 'Feature', properties: {}, geometry: segment.length === 1
                ? { type: 'Point', coordinates: [segment[0].lon, segment[0].lat] }
                : { type: 'LineString', coordinates: segment.map(p => [p.lon, p.lat]) },
            })),
          } });
        });
        // All halos go below all routes so an overlapping run cannot erase another.
        this.tracks.forEach((_, i) => map.addLayer({ id: `route-halo-${i}`, type: 'line', source: `review-route-${i}`, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': .8 } }));
        this.tracks.forEach((track, i) => {
          map.addLayer({ id: `route-line-${i}`, type: 'line', source: `review-route-${i}`, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
            'line-color': this.color(i), 'line-width': 3.5,
            ...(track.role === 'reference' ? { 'line-dasharray': [2, 2] } : {}),
          } });
          map.addLayer({ id: `route-point-${i}`, type: 'circle', source: `review-route-${i}`, filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 4, 'circle-color': this.color(i), 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
        });
        this.finish();
      });
      map.on('moveend', () => { this.zoom = map.getZoom(); this.cd.markForCheck(); });
      map.on('dragstart', () => { this.view = 'custom'; this.cd.markForCheck(); });
    } catch {
      if (generation === this.generation) this.error = 'No se pudo cargar el mapa.';
    } finally { this.cd.markForCheck(); }
  }

  private async initializeRaster(generation: number): Promise<void> {
    const L = await import('leaflet/dist/leaflet-src.esm.js');
    if (generation !== this.generation) return;
    this.fallback = true; this.baseUnavailable = false;
    const map = this.raster = L.map(this.element!.nativeElement, { preferCanvas: true, scrollWheelZoom: false, zoomControl: false, zoomSnap: .25, zoomDelta: .5, minZoom: 2, maxZoom: 19 });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).on('tileerror', () => { this.baseUnavailable = true; this.cd.markForCheck(); }).addTo(map);
    L.control.scale({ imperial: false, maxWidth: 90 }).addTo(map);
    this.rasterGroups = this.tracks.map((track, i) => {
      const group = L.layerGroup().addTo(map);
      track.segments.forEach(segment => {
        const points = segment.map(p => L.latLng(p.lat, p.lon));
        if (!points.length) return;
        const label = document.createElement('span'); label.textContent = track.name;
        if (points.length === 1) L.circleMarker(points[0], { color: this.color(i), radius: 4 }).bindTooltip(label).addTo(group);
        else L.polyline(points, { color: this.color(i), weight: 4, dashArray: track.role === 'reference' ? '6 5' : undefined, smoothFactor: 0 }).bindTooltip(label).addTo(group);
      });
      return group;
    });
    map.on('moveend', () => { this.zoom = map.getZoom(); this.cd.markForCheck(); });
    map.on('dragstart', () => { this.view = 'custom'; this.cd.markForCheck(); });
    this.finish();
  }

  private finish(): void {
    this.ready = true;
    this.frame(false);
    this.resize = new ResizeObserver(() => { this.map?.resize(); this.raster?.invalidateSize(); });
    this.resize.observe(this.element!.nativeElement);
    this.cd.markForCheck();
  }
  frame(detail: boolean): void {
    if (!this.bounds) return;
    this.view = detail ? 'detail' : 'route';
    const extra = detail ? .55 : 0;
    if (this.map) {
      const camera = this.map.cameraForBounds(this.bounds, { padding: { top: 72, bottom: 38, left: 24, right: 24 }, maxZoom: 18 });
      if (camera) this.map.jumpTo({ ...camera, zoom: Math.min(19, (camera.zoom || 0) + extra) });
      this.zoom = this.map.getZoom();
    } else if (this.raster) {
      const b = this.bounds.map(p => [p[1], p[0]]);
      this.raster.fitBounds(b, { paddingTopLeft: [24, 72], paddingBottomRight: [24, 38], maxZoom: 18, animate: false });
      if (detail) this.raster.setZoom(Math.min(19, this.raster.getZoom() + .5), { animate: false });
      this.zoom = this.raster.getZoom();
    }
  }
  changeZoom(delta: number): void {
    this.view = 'custom';
    const zoom = Math.min(19, Math.max(2, this.zoom + delta));
    this.map?.jumpTo({ zoom }); this.raster?.setZoom(zoom, { animate: false });
  }
  toggle(index: number): void {
    this.visible[index] = !this.visible[index];
    if (this.map) for (const type of ['halo', 'line', 'point']) this.map.setLayoutProperty(`route-${type}-${index}`, 'visibility', this.visible[index] ? 'visible' : 'none');
    if (this.raster) {
      const group = this.rasterGroups[index];
      if (this.visible[index]) group.addTo(this.raster); else this.raster.removeLayer(group);
    }
  }
  private dispose(): void {
    this.generation++; this.abort?.abort(); this.resize?.disconnect();
    this.map?.remove(); this.map = undefined;
    this.raster?.remove(); this.raster = undefined; this.rasterGroups = [];
  }
  ngOnDestroy(): void { this.dispose(); }
}
