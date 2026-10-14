import { UiIconComponent } from './ui-icon.component';
import { Component, ElementRef, Input, OnChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { reviewMedia, ReviewMediaItem } from './review-media';

@Component({
  selector: 'app-review-media',
  standalone: true,
  imports: [UiIconComponent, CommonModule],
  template: `<ng-container *ngIf="payload as p">
      <div class="review-media" *ngIf="selectedMedia as selected" role="region" aria-label="Fotos y vídeos de la review">
        <div class="media-stage" [class.showing-video]="selected.kind === 'video'">
          <img *ngIf="selected.kind === 'image'" class="media-image"
            [src]="image(selected.id)" [attr.srcset]="srcset(selected.id)"
            sizes="(max-width: 640px) 92vw, 900px" [alt]="selected.title"
            [attr.width]="p.media[selected.id]?.width" [attr.height]="p.media[selected.id]?.height"
            fetchpriority="high" />
          <ng-container *ngIf="selected.kind === 'video'">
            <ng-container *ngIf="heroVideoPlaying; else videoPoster">
              <iframe *ngIf="video(selected.id) as url" [src]="url" [title]="selected.title"
                allow="fullscreen; picture-in-picture" allowfullscreen></iframe>
            </ng-container>
            <ng-template #videoPoster>
              <img *ngIf="selected.primary && p.media[p.article.cover.media_id]" class="video-poster"
                [src]="image(p.article.cover.media_id)" [attr.srcset]="srcset(p.article.cover.media_id)"
                sizes="(max-width: 640px) 92vw, 900px" alt="" fetchpriority="high" />
              <button type="button" class="hero-play" (click)="heroVideoPlaying = true"
                [attr.aria-label]="'Reproducir ' + selected.title.toLowerCase()">
                <span class="play-icon" aria-hidden="true"><svg appIcon="play"></svg></span><span>Reproducir vídeo</span>
              </button>
            </ng-template>
          </ng-container>
        </div>
        <div class="media-thumbnails" role="group" aria-label="Seleccionar foto o vídeo" (keydown)="mediaKey($event)">
          <button type="button" *ngFor="let item of mediaItems; let i = index; trackBy: mediaKeyId"
            class="media-thumbnail" [class.selected]="i === selectedMediaIndex" [class.video-thumbnail]="item.kind === 'video'"
            [attr.aria-pressed]="i === selectedMediaIndex" [attr.aria-label]="mediaLabel(item, i)"
            (click)="selectMedia(i)">
            <img *ngIf="item.kind === 'image'" [src]="thumbnail(item.id)" alt="" loading="lazy" width="120" height="76" />
            <img *ngIf="item.primary && p.media[p.article.cover.media_id]" [src]="thumbnail(p.article.cover.media_id)"
              alt="" loading="lazy" width="120" height="76" />
            <span *ngIf="item.kind === 'video'" class="thumbnail-play" aria-hidden="true"><svg appIcon="play"></svg></span>
            <span class="thumbnail-label">{{ item.kind === 'video' ? (item.primary ? 'Vídeo principal' : 'Vídeo') : 'Foto' }}</span>
          </button>
        </div>
        <div class="media-footer">
          <p class="media-caption" aria-live="polite" aria-atomic="true">
            <span class="media-count">{{ selectedMediaIndex + 1 }} / {{ mediaItems.length }}</span>
            {{ selected.caption || selected.title }}
          </p>
          <div class="media-controls" *ngIf="mediaItems.length > 1">
            <button type="button" aria-label="Multimedia anterior" [disabled]="selectedMediaIndex === 0"
              (click)="selectMedia(selectedMediaIndex - 1)"><svg appIcon="arrow-left"></svg></button>
            <button type="button" aria-label="Multimedia siguiente" [disabled]="selectedMediaIndex === mediaItems.length - 1"
              (click)="selectMedia(selectedMediaIndex + 1)"><svg appIcon="arrow-right"></svg></button>
          </div>
        </div>
        <a *ngIf="selected.kind === 'video'" class="video-source"
          [href]="'https://www.youtube.com/watch?v=' + selected.id" target="_blank" rel="noopener noreferrer">
          Abrir el vídeo en YouTube <svg appIcon="arrow-up-right"></svg></a>
      </div>
  </ng-container>`,
  styles: [`
    :host {display:block;min-width:0}
    img {display:block;max-width:100%}
    iframe {border:0}
      .review-media {min-width:0}
      .media-stage {position:relative;aspect-ratio:16/9;background:var(--surface-2,#f7f7f7);overflow:hidden}
      .media-stage.showing-video {background:#161616}
      .media-stage img,.media-stage iframe {display:block;width:100%;height:100%;max-height:none;margin:0;object-fit:contain}
      .hero-play {position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;border:0;background:linear-gradient(transparent,rgba(0,0,0,.45));color:white;cursor:pointer;font:inherit}
      .hero-play>span:last-child {padding:5px 12px;background:#161616;font-size:13px}
      .play-icon {display:grid;place-items:center;width:64px;height:64px;border-radius:50%;background:var(--accent,#0055ff);--icon-size:26px;line-height:1;padding-left:2px}
      .hero-play:hover .play-icon {background:var(--accent-hover,#002aff)}
      .hero-play:focus-visible {outline:3px solid white;outline-offset:-6px}
      .media-thumbnails {display:flex;gap:8px;overflow-x:auto;overscroll-behavior-x:contain;scroll-snap-type:x proximity;padding:8px 3px;margin:4px -3px 0;scrollbar-width:thin;scrollbar-color:var(--ink-3,#505050) var(--surface-2,#f7f7f7)}
      .media-thumbnail {position:relative;flex:0 0 120px;height:80px;padding:0;border:2px solid transparent;background:var(--surface-2,#f7f7f7);cursor:pointer;scroll-snap-align:start;color:white;border-radius:0;overflow:hidden}
      .media-thumbnail img {width:100%;height:100%;object-fit:cover;max-height:none;margin:0}
      .media-thumbnail.selected {border-color:var(--accent,#0055ff);box-shadow:0 0 0 1px var(--accent,#0055ff)}
      .media-thumbnail:focus-visible,.media-controls button:focus-visible {outline:2px solid var(--accent,#0055ff);outline-offset:2px}
      .video-thumbnail {background:#161616}
      .thumbnail-play {position:absolute;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.25);--icon-size:24px}
      .thumbnail-label {position:absolute;bottom:0;left:0;padding:2px 6px;background:#161616;color:white;font:10px/1.6 var(--font-body,sans-serif)}
      .media-footer {display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-top:8px}
      .media-caption {margin:0;font-size:12px;line-height:1.6;color:var(--ink-3,#505050)}
      .media-count {display:inline-block;white-space:nowrap;margin-right:8px;font-family:var(--font-mono,monospace);color:var(--ink,#161616)}
      .media-controls {display:flex;flex-shrink:0;gap:6px}
      .media-controls button {display:grid;place-items:center;width:40px;height:40px;border:1px solid var(--line,#ddd);background:var(--surface,#fff);color:var(--ink,#161616);font-size:20px;cursor:pointer;border-radius:0}
      .media-controls button:hover:enabled {background:var(--accent-soft,#edf3ff);border-color:var(--accent,#0055ff)}
      .media-controls button:disabled {opacity:.35;cursor:default}
      .video-source {
        display: inline-flex;
        align-items:center;gap:6px;
        margin: 12px 0;
        font-size: 0.85rem;
      }
    a {color:var(--accent,#0055ff);text-decoration:underline}
  `],
})

export class ReviewMediaComponent implements OnChanges {
  @Input() payload: any;
  @Input() publicMode = false;
  mediaItems: ReviewMediaItem[] = [];
  selectedMediaIndex = 0;
  heroVideoPlaying = false;
  private element = inject<ElementRef<HTMLElement>>(ElementRef);
  private sanitizer = inject(DomSanitizer);
  private videos = new Map<string, SafeResourceUrl>();

  ngOnChanges(): void {
    this.mediaItems = reviewMedia(this.payload);
    this.selectedMediaIndex = 0;
    this.heroVideoPlaying = false;
  }
  get selectedMedia(): ReviewMediaItem | undefined { return this.mediaItems[this.selectedMediaIndex]; }
  mediaKeyId(_index: number, item: ReviewMediaItem): string { return item.key; }
  mediaLabel(item: ReviewMediaItem, index: number): string {
    return `${index + 1} de ${this.mediaItems.length}: ${item.kind === 'video' ? 'Ver vídeo' : 'Ver foto'} — ${item.title}`;
  }
  selectMedia(index: number): void {
    if (index < 0 || index >= this.mediaItems.length) return;
    this.selectedMediaIndex = index;
    this.heroVideoPlaying = this.mediaItems[index].kind === 'video';
    this.element.nativeElement.querySelectorAll<HTMLElement>('.media-thumbnail')[index]
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  mediaKey(event: KeyboardEvent): void {
    const buttons = Array.from(this.element.nativeElement.querySelectorAll<HTMLButtonElement>('.media-thumbnail'));
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : event.key === 'ArrowRight' ? Math.min(index + 1, buttons.length - 1)
      : event.key === 'ArrowLeft' ? Math.max(index - 1, 0) : -1;
    if (next < 0) return;
    event.preventDefault();
    this.selectMedia(next);
    buttons[next]?.focus({ preventScroll: true });
  }
  thumbnail(id: string): string { return this.image(id) + (this.publicMode ? '&w=400' : ''); }
  image(id: string): string {
    return this.publicMode
      ? `/api/public/reviews/${encodeURIComponent(this.payload.article.slug)}/media/${id}?version=${this.payload.version}`
      : `/api/review-media/${id}`;
  }
  srcset(id: string): string | null {
    return this.publicMode
      ? [400, 800, 1200, 1600]
          .map((w) => this.image(id) + "&w=" + w + " " + w + "w")
          .join(", ")
      : null;
  }
  video(id: string): SafeResourceUrl | null {
    if (!/^[\w-]{11}$/.test(id || "")) return null;
    if (!this.videos.has(id))
      this.videos.set(
        id,
        this.sanitizer.bypassSecurityTrustResourceUrl(
          "https://www.youtube-nocookie.com/embed/" + id,
        ),
      );
    return this.videos.get(id)!;
  }
}
