import {
  Component, Input, ViewChild, ElementRef,
  AfterViewInit, OnDestroy, OnChanges, SimpleChanges,
} from '@angular/core';

export type DrawTool = 'pen' | 'eraser';

@Component({
  selector: 'app-drawing-canvas',
  standalone: true,
  template: `
    <canvas #canvas class="draw-canvas"
      [style.pointer-events]="enabled ? 'auto' : 'none'"
      [style.cursor]="enabled ? (tool === 'eraser' ? 'cell' : 'crosshair') : 'default'"
      (pointerdown)="onDown($event)"
      (pointermove)="onMove($event)"
      (pointerup)="onUp($event)"
      (pointerleave)="onUp($event)">
    </canvas>`,
  styles: [`
    :host { position: absolute; inset: 0; display: block; pointer-events: none; }
    .draw-canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  `],
})
export class DrawingCanvasComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() enabled    = false;
  @Input() color      = '#e53e3e';
  @Input() strokeWidth = 3;
  @Input() tool: DrawTool = 'pen';

  @ViewChild('canvas') private canvasEl!: ElementRef<HTMLCanvasElement>;

  get canvas(): HTMLCanvasElement { return this.canvasEl?.nativeElement; }

  private ctx!: CanvasRenderingContext2D;
  private drawing = false;
  private lastX = 0;
  private lastY = 0;
  private ro!: ResizeObserver;

  ngAfterViewInit(): void {
    this.ctx = this.canvas.getContext('2d')!;
    this._syncSize();
    this.ro = new ResizeObserver(() => this._syncSize(true));
    this.ro.observe(this.canvas.parentElement!);
  }

  ngOnChanges(changes: SimpleChanges): void {
    // Re-enable pointer events on host when enabled changes
    if (changes['enabled'] && this.canvasEl) {
      (this.canvasEl.nativeElement.parentElement as HTMLElement | null)
        ?.style.setProperty('pointer-events', changes['enabled'].currentValue ? 'auto' : 'none');
    }
  }

  ngOnDestroy(): void { this.ro?.disconnect(); }

  // ── Public API ────────────────────────────────────────────────────────────
  clear(): void {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Returns a data-URL of the drawing canvas merged on top of the given source. */
  composite(source: HTMLCanvasElement | HTMLImageElement): string {
    const out = document.createElement('canvas');
    const src = source instanceof HTMLCanvasElement ? source : null;
    const img = source instanceof HTMLImageElement  ? source : null;

    out.width  = src ? src.width  : (img ? img.naturalWidth  : this.canvas.width);
    out.height = src ? src.height : (img ? img.naturalHeight : this.canvas.height);

    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(source, 0, 0, out.width, out.height);
    if (this.canvas.width > 0) {
      ctx.drawImage(this.canvas, 0, 0, out.width, out.height);
    }
    return out.toDataURL('image/png');
  }

  // ── Pointer handlers ──────────────────────────────────────────────────────
  onDown(e: PointerEvent): void {
    if (!this.enabled) return;
    this.drawing = true;
    const [x, y] = this._coords(e);
    this.lastX = x; this.lastY = y;
    this._segment(x, y, x, y);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  onMove(e: PointerEvent): void {
    if (!this.drawing || !this.enabled) return;
    const [x, y] = this._coords(e);
    this._segment(this.lastX, this.lastY, x, y);
    this.lastX = x; this.lastY = y;
    e.preventDefault();
  }

  onUp(e: PointerEvent): void {
    this.drawing = false;
    e.preventDefault();
  }

  // ── Internal ──────────────────────────────────────────────────────────────
  private _coords(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private _segment(x1: number, y1: number, x2: number, y2: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';

    if (this.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = this.strokeWidth * 5;
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth = this.strokeWidth;
      ctx.strokeStyle = this.color;
    }
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }

  private _syncSize(preserve = false): void {
    const el  = this.canvas;
    const par = el.parentElement;
    if (!par) return;
    const w = par.offsetWidth;
    const h = par.offsetHeight;
    if (w === 0 || h === 0) return;

    let saved = '';
    if (preserve && el.width > 0 && el.height > 0) saved = el.toDataURL();

    el.width  = w;
    el.height = h;

    if (saved) {
      const img = new Image();
      img.onload = () => this.ctx.drawImage(img, 0, 0, w, h);
      img.src = saved;
    }
  }
}
