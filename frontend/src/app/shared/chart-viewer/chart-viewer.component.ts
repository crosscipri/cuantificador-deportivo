import {
  Component, Input, HostListener,
  ElementRef, ViewChild, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule }   from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { DrawingCanvasComponent, DrawTool } from '../drawing-canvas/drawing-canvas.component';

@Component({
  selector: 'app-chart-viewer',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule, MatTooltipModule, DrawingCanvasComponent],
  templateUrl: './chart-viewer.component.html',
  styleUrls: ['./chart-viewer.component.scss'],
})
export class ChartViewerComponent {
  @Input() chartB64 = '';
  @Input() title    = 'Gráfica';
  @Input() filename = 'chart.png';

  @ViewChild('lightboxImg') lightboxImg?: ElementRef<HTMLImageElement>;
  @ViewChild(DrawingCanvasComponent) drawCanvas?: DrawingCanvasComponent;

  // ── Lightbox state ──────────────────────────────────────────────────────
  lightboxOpen = signal(false);
  zoom         = signal(1);
  translateX   = signal(0);
  translateY   = signal(0);

  drawingMode = false;
  drawColor   = '#e53e3e';
  drawStroke  = 3;
  drawTool: DrawTool = 'pen';

  readonly STROKES = [2, 5, 10];

  // Panning
  _dragging  = false;
  private _dragStart = { x: 0, y: 0 };
  private _panStart  = { x: 0, y: 0 };

  get imgSrc(): string {
    return `data:image/png;base64,${this.chartB64}`;
  }

  get transformStyle(): string {
    return `scale(${this.zoom()}) translate(${this.translateX()}px, ${this.translateY()}px)`;
  }

  // ── Lightbox open / close ────────────────────────────────────────────────
  openLightbox(): void {
    this.zoom.set(1);
    this.translateX.set(0);
    this.translateY.set(0);
    this.drawingMode = false;
    this.lightboxOpen.set(true);
    document.body.style.overflow = 'hidden';
  }

  closeLightbox(): void {
    this.lightboxOpen.set(false);
    document.body.style.overflow = '';
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.lightboxOpen()) this.closeLightbox();
  }

  // ── Zoom ─────────────────────────────────────────────────────────────────
  private readonly MIN_ZOOM = 0.5;
  private readonly MAX_ZOOM = 6;

  zoomIn():    void { this._applyZoom(this.zoom() * 1.25); }
  zoomOut():   void { this._applyZoom(this.zoom() * 0.8);  }
  resetView(): void { this.zoom.set(1); this.translateX.set(0); this.translateY.set(0); }

  private _applyZoom(next: number): void {
    this.zoom.set(Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, next)));
    if (this.zoom() === 1) { this.translateX.set(0); this.translateY.set(0); }
  }

  onWheel(event: WheelEvent): void {
    if (this.drawingMode) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.1 : 0.9;
    this._applyZoom(this.zoom() * factor);
  }

  // ── Pan ──────────────────────────────────────────────────────────────────
  onMouseDown(event: MouseEvent): void {
    if (this.drawingMode) return;
    if (this.zoom() <= 1) return;
    this._dragging  = true;
    this._dragStart = { x: event.clientX, y: event.clientY };
    this._panStart  = { x: this.translateX(), y: this.translateY() };
    event.preventDefault();
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    if (!this._dragging) return;
    const dx = (event.clientX - this._dragStart.x) / this.zoom();
    const dy = (event.clientY - this._dragStart.y) / this.zoom();
    this.translateX.set(this._panStart.x + dx);
    this.translateY.set(this._panStart.y + dy);
  }

  @HostListener('document:mouseup')
  onMouseUp(): void { this._dragging = false; }

  // ── Drawing ───────────────────────────────────────────────────────────────
  setColor(e: Event): void {
    this.drawColor = (e.target as HTMLInputElement).value;
  }

  clearDrawing(): void { this.drawCanvas?.clear(); }

  // ── Download ─────────────────────────────────────────────────────────────
  download(): void {
    if (this.drawCanvas) {
      const img = new Image();
      img.onload = () => {
        const dataUrl = this.drawCanvas!.composite(img);
        const a = document.createElement('a');
        a.href = dataUrl; a.download = this.filename; a.click();
      };
      img.src = this.imgSrc;
    } else {
      const a    = document.createElement('a');
      a.href     = this.imgSrc;
      a.download = this.filename;
      a.click();
    }
  }
}
