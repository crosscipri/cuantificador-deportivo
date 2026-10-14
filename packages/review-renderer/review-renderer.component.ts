import { UiIconComponent } from './ui-icon.component';
import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, Input, OnChanges, OnDestroy, PLATFORM_ID, inject } from "@angular/core";
import { CommonModule, isPlatformBrowser } from "@angular/common";
import { DomSanitizer, SafeResourceUrl } from "@angular/platform-browser";
import { ReviewEvidenceComponent } from "./review-evidence.component";
import { ReviewMediaComponent } from "./review-media.component";
import { ReviewVerdictComponent } from "./review-verdict.component";
import { reviewConclusionLayout } from "./review-scores";

@Component({
  selector: "app-review-renderer",
  standalone: true,
  imports: [UiIconComponent, CommonModule, ReviewEvidenceComponent, ReviewMediaComponent, ReviewVerdictComponent],
  template: ` <article *ngIf="payload as p" class="review-layout">
    <header class="review-header">
      <p class="eyebrow">{{ p.device.name }}</p>
      <h1>{{ p.article.title }}</h1>
      <div class="review-byline">
        <a class="review-author" href="/autor/cipri">
          <svg class="author-mark" aria-hidden="true" viewBox="0 0 40 40">
            <rect width="40" height="40" fill="currentColor" />
            <path d="M5 20h6l4-9 6 19 5-14 3 4h6" fill="none" stroke="white" stroke-width="2.8" />
          </svg>
          El Cuantificador
        </a>
        <span class="publication-date" *ngIf="publicationDate; else unpublished">Publicado el
          <time [attr.datetime]="publicationDate">{{ publicationDate | date:'dd/MM/yyyy' }}</time>
        </span>
        <ng-template #unpublished><span class="publication-date">Publicación pendiente</span></ng-template>
        <span class="update-date" *ngIf="updateDate">{{ p.preview ? 'Borrador actualizado el' : 'Actualizado el' }}
          <time [attr.datetime]="updateDate">{{ updateDate | date:'dd/MM/yyyy' }}</time>
        </span>
      </div>
      <app-review-media [payload]="p" [publicMode]="publicMode"></app-review-media>
      <section *ngIf="conclusion" class="review-conclusion" [attr.id]="conclusion.id" [attr.data-heading]="conclusion.id">
        <app-review-verdict [verdict]="conclusion"></app-review-verdict>
      </section>
      <p class="summary">{{ p.article.summary }}</p>
    </header>
    <ng-template #tocLinks>
      <a *ngFor="let h of headings" [href]="'#'+h.id" [class.subheading]="h.level===3"
        [class.current]="activeHeading===h.id" [attr.aria-current]="activeHeading===h.id ? 'location' : null"
        (click)="jump($event,h.id)">{{h.text}}</a>
    </ng-template>
    <nav class="review-toc" aria-label="Índice de la review" *ngIf="headings.length">
      <div class="toc-desktop"><strong>En esta review</strong><ng-container *ngTemplateOutlet="tocLinks"></ng-container></div>
      <details class="toc-mobile"><summary>Índice de la review</summary><ng-container *ngTemplateOutlet="tocLinks"></ng-container></details>
    </nav>
    <aside id="comprar" class="purchase-rail" aria-label="Precios y enlaces de compra">
      <div class="purchase-card">
        <span class="eyebrow">Precios y disponibilidad</span>
        <h2>Dónde comprar</h2>
        <p class="purchase-product">{{p.device.name}}</p>
        <p *ngIf="!purchaseLinks.length" class="purchase-empty">Todavía no hay enlaces de compra disponibles.</p>
        <a class="shop-link" *ngFor="let link of purchaseLinks" [href]="link.url" target="_blank" rel="sponsored noopener noreferrer">
          <span class="shop-name">{{link.label}} <span aria-hidden="true"><svg appIcon="arrow-up-right"></svg></span></span>
          <strong *ngIf="link.price != null; else checkPrice">{{link.price | currency:(link.currency || 'EUR'):'symbol':'1.2-2'}}</strong>
          <ng-template #checkPrice><span class="check-price">Consultar precio</span></ng-template>
          <small *ngIf="link.price != null && link.price_checked_at">Consultado {{link.price_checked_at | date:'dd/MM/yyyy'}}</small>
        </a>
        <p class="price-note" *ngIf="purchaseLinks.length">Comprueba el precio final y la disponibilidad en la tienda.</p>
        <p class="affiliate-note" *ngFor="let notice of affiliateNotices">{{notice}}</p>
      </div>
    </aside>
    <div class="review-body">
    <section
      *ngFor="let b of bodyBlocks"
      [attr.id]="b.id"
      [attr.data-heading]="b.type==='heading' ? b.id : null"
      [ngSwitch]="b.type"
    >
      <div *ngSwitchCase="'heading'">
        <h2 *ngIf="b.level === 2">{{ b.text }}</h2>
        <h3 *ngIf="b.level === 3">{{ b.text }}</h3>
      </div>
      <div *ngSwitchCase="'text'" [innerHTML]="b.html"></div>
      <ng-container *ngSwitchCase="'image'"
        ><figure *ngFor="let m of b.media">
          <img
            [src]="image(m.media_id)"
            [attr.srcset]="srcset(m.media_id)"
            sizes="(max-width: 640px) 92vw, 800px"
            [alt]="m.alt"
            [attr.width]="p.media[m.media_id]?.width"
            [attr.height]="p.media[m.media_id]?.height"
            loading="lazy"
          />
          <figcaption>{{ m.caption }}</figcaption>
        </figure></ng-container
      >
      <div class="gallery" *ngSwitchCase="'gallery'">
        <figure *ngFor="let m of b.media">
          <img
            [src]="image(m.media_id)"
            [attr.srcset]="srcset(m.media_id)"
            sizes="(max-width: 640px) 92vw, 800px"
            [alt]="m.alt"
            [attr.width]="p.media[m.media_id]?.width"
            [attr.height]="p.media[m.media_id]?.height"
            loading="lazy"
          />
          <figcaption>{{ m.caption }}</figcaption>
        </figure>
      </div>
      <div *ngSwitchCase="'video'">
        <h3>{{ b.title }}</h3>
        <button
          class="video-button"
          *ngIf="b.video && !activeVideos.has(b.video)"
          (click)="activeVideos.add(b.video)"
        >
          <svg appIcon="play"></svg> Cargar vídeo</button
        ><iframe
          *ngIf="activeVideos.has(b.video) && video(b.video) as url"
          [src]="url"
          [title]="b.title || 'Vídeo de YouTube'"
          allowfullscreen
          loading="lazy"
        ></iframe>
      </div>
      <app-review-verdict *ngSwitchCase="'verdict'" [verdict]="b"></app-review-verdict>
      <div *ngSwitchCase="'alternatives'">
        <h3>{{ b.title || "Alternativas" }}</h3>
        <p *ngFor="let a of b.alternatives">
          <strong>{{ a.name }}</strong> · {{ a.reason }}
        </p>
      </div>
      <div *ngSwitchCase="'purchase'">
        <h3>{{ b.title || "Dónde comprar" }}</h3>
        <p>{{ b.affiliate_notice }}</p>
        <a
          class="buy"
          *ngFor="let link of b.links"
          [href]="link.url"
          target="_blank"
          rel="sponsored noopener noreferrer"
          >{{ link.label }}<span *ngIf="link.price != null"> · {{link.price | currency:(link.currency || 'EUR'):'symbol':'1.2-2'}}</span></a
        >
      </div>
      <div *ngSwitchCase="'table'">
        <h3>{{ b.title }}</h3>
        <div class="table" *ngIf="b.table_origin === 'editorial'">
          <table>
            <tbody>
              <tr *ngFor="let row of b.rows; let first = first">
                <ng-container *ngFor="let cell of row"
                  ><th *ngIf="first" scope="col">{{ cell }}</th>
                  <td *ngIf="!first">{{ cell }}</td></ng-container
                >
              </tr>
            </tbody>
          </table>
        </div>
        <app-review-evidence
          *ngIf="b.table_origin === 'results'"
          [evidence]="p.evidence[b.evidence_id]"
          [title]="b.title"
          [evidenceUrl]="evidenceUrl(b.evidence_id)"
        ></app-review-evidence>
        <p>{{ b.caption }}</p>
        <p>{{ b.explanation }}</p>
      </div>
      <div *ngSwitchCase="'chart'">
        <h3>{{ b.title }}</h3>
        <app-review-evidence
          [evidence]="p.evidence[b.evidence_id]"
          [title]="b.title"
          [evidenceUrl]="evidenceUrl(b.evidence_id)"
        ></app-review-evidence>
        <p>{{ b.caption }}</p>
        <p>{{ b.explanation }}</p>
      </div>
      <div *ngSwitchCase="'map'">
        <h3>{{ b.title }}</h3>
        <app-review-evidence
          [evidence]="p.evidence[b.evidence_id]"
          [title]="b.title"
          [evidenceUrl]="evidenceUrl(b.evidence_id)"
        ></app-review-evidence>
        <p>{{ b.caption }}</p>
        <p>{{ b.explanation }}</p>
      </div>
    </section>
    </div>
  </article>`,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
        container-type: inline-size;
        container-name: review;
      }
      article {
        max-width: 1440px;
        margin: auto;
        background: var(--surface);
        padding: 16px;
        overflow-wrap: anywhere;
      }
      h1 {
        font-family: var(--font-display);
        font-size: clamp(28px, 4vw, 46px);
        line-height: 1.15;
        margin: 16px 0;
      }
      h2 {
        margin-top: 2rem;
      }
      .summary {
        font-size: 1.2rem;
      }
      img {
        display: block;
        max-width: 100%;
        max-height: 650px;
        object-fit: contain;
        height: auto;
        margin: auto;
      }
      iframe {
        width: 100%;
        aspect-ratio: 16/9;
        border: 0;
      }
      figure {
        margin: 1rem 0;
      }
      figcaption {
        font-size: 0.85rem;
        color: var(--ink-3);
      }
      nav {
        background: var(--surface-2);
        padding: 20px;
        margin: 24px 0;
      }
      nav a {
        display: block;
        margin: 6px 0;
      }
      .review-layout {display:grid;gap:24px;min-width:0}
      .review-header,.review-body {min-width:0}
      .review-header {grid-row:1}
      .review-toc {grid-row:2;margin:0;padding:0;background:transparent}
      .purchase-rail {grid-row:3;min-width:0}
      .review-body {grid-row:4}
      .toc-desktop {display:none}
      .toc-mobile {border:1px solid var(--line,#ddd);padding:14px 18px}
      .toc-mobile summary {cursor:pointer;font-weight:600}
      .review-toc a {font-size:13px;line-height:1.5;text-decoration:none;color:var(--ink-3,#505050);padding:7px 0 7px 12px;border-left:2px solid var(--line,#ddd);margin:0}
      .review-toc a.current,.review-toc a:hover {color:var(--accent,#0055ff);border-left-color:var(--accent,#0055ff)}
      .review-toc a.subheading {padding-left:24px;font-size:12px}
      .review-toc strong {display:block;margin-bottom:18px;font:12px var(--font-mono,monospace);text-transform:uppercase}
      .purchase-card {padding:24px;border:1px solid var(--line,#ddd);background:var(--surface,#fff)}
      .purchase-card h2 {font-size:25px;margin:12px 0;border:0;padding:0;letter-spacing:-.035em}
      .purchase-product {font-size:14px;line-height:1.5;color:var(--ink-3,#505050)}
      .shop-link {display:grid;gap:6px;padding:16px 0;border-top:1px solid var(--line,#ddd);text-decoration:none;color:var(--ink,#161616)}
      .shop-name {display:flex;justify-content:space-between;gap:10px;font-size:14px}
      .shop-link strong {font-size:26px;line-height:1.2;color:var(--accent,#0055ff)}
      .shop-link small,.check-price {font-size:12px}
      .price-note,.affiliate-note,.purchase-empty {font-size:12px;line-height:1.6;color:var(--ink-3,#505050)}
      .affiliate-note {padding-top:12px;border-top:1px solid var(--line,#ddd)}
      @container review (min-width: 1080px) {
        .review-layout {grid-template-columns:180px minmax(0,1fr) 240px;column-gap:32px;row-gap:28px;padding:0}
        .review-header {grid-column:2;grid-row:1}
        .review-body {grid-column:2;grid-row:2}
        .review-toc {grid-column:1;grid-row:1 / span 2;position:sticky;top:24px;align-self:start;max-height:calc(100vh - 48px);overflow:auto}
        .toc-desktop {display:block}
        .toc-mobile {display:none}
        .purchase-rail {grid-column:3;grid-row:1 / span 2;position:sticky;top:24px;align-self:start;max-height:calc(100vh - 48px);overflow:auto}
      }
      .gallery {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr));
        gap: 12px;
      }
      .review-conclusion {margin-top:24px}
      .buy {
        display: inline-block;
        margin: 8px;
        padding: 10px;
        background: var(--accent-soft);
      }
      .table {
        overflow: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      td,
      th {
        text-align: left;
        border-bottom: 1px solid var(--line);
        padding: 10px;
      }
      section {
        scroll-margin-top: 90px;
      }
      article {
        line-height: 1.8;
      }
      p,
      li {
        max-width: 75ch;
      }
      .eyebrow {
        font-size: 0.85rem;
        color: var(--ink-3);
      }
      .video-button {
        display: block;
        width: 100%;
        min-height: 160px;
        margin: 20px 0;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: var(--surface-2);
        color: var(--ink);
        font: inherit;
        cursor: pointer;
      }
      .review-byline {display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;margin:0 0 20px;font-size:12px;line-height:1.5;color:var(--ink-3,#505050)}
      .review-author {display:inline-flex;align-items:center;gap:8px;text-decoration:none;font-weight:500;font-size:13px}
      .author-mark {width:30px;height:30px;flex-shrink:0;color:var(--accent,#0055ff)}
      .update-date {border-left:1px solid var(--line,#ddd);padding-left:12px}
      a {
        color: var(--accent, #136f63);
        text-decoration: underline;
      }
    `,
  ],
})
export class ReviewRendererComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() payload: any;
  @Input() publicMode = false;
  activeVideos = new Set<string>();
  conclusion:any=null;
  bodyBlocks:any[]=[];
  headings:any[]=[];
  activeHeading = '';
  private element:ElementRef<HTMLElement>=inject(ElementRef);
  private platform=inject(PLATFORM_ID);
  private cd=inject(ChangeDetectorRef);
  private headingObserver?:IntersectionObserver;
  private destroyed=false;
  ngOnChanges():void {
    const layout=reviewConclusionLayout(this.payload?.article?.blocks);
    this.conclusion=layout.conclusion;this.bodyBlocks=layout.body;
    this.headings=[...(this.conclusion ? [{id:this.conclusion.id,level:2,text:this.conclusion.title || 'Nuestra conclusión'}] : []),
      ...this.bodyBlocks.filter((b:any)=>b.type==='heading')];
    this.activeVideos.clear();
    this.activeHeading=this.headings[0]?.id || '';
    if(isPlatformBrowser(this.platform))queueMicrotask(()=>this.watchHeadings());
  }
  ngAfterViewInit():void {if(isPlatformBrowser(this.platform))this.watchHeadings();}
  private watchHeadings():void {
    if(this.destroyed||typeof IntersectionObserver==='undefined')return;
    this.headingObserver?.disconnect();
    this.headingObserver=new IntersectionObserver(entries=>{
      const visible=entries.filter(e=>e.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top);
      if(visible.length){this.activeHeading=(visible[0].target as HTMLElement).dataset['heading'] || '';this.cd.markForCheck();}
    },{root:this.element.nativeElement.closest('.preview-body'),rootMargin:'-10% 0px -65% 0px'});
    this.element.nativeElement.querySelectorAll('[data-heading]').forEach(el=>this.headingObserver!.observe(el));
  }
  ngOnDestroy():void {this.destroyed=true;this.headingObserver?.disconnect();}
  get publicationDate(): string | null { return this.payload?.first_published_at || this.payload?.preview?.first_published_at || null; }
  get updateDate(): string | null { return this.payload?.preview?.saved_at || this.payload?.published_at || null; }
  get purchaseLinks(): any[] { return this.payload?.device?.purchase_links || []; }
  get affiliateNotices(): string[] {
    return [...new Set<string>((this.payload?.article?.blocks || []).filter((b:any)=>b.type==='purchase' && b.affiliate_notice).map((b:any)=>b.affiliate_notice))];
  }
  evidenceUrl(id: string): string {
    return `/api/public/reviews/${encodeURIComponent(this.payload.article.slug)}/evidence/${id}?version=${this.payload.version}`;
  }
  private videos = new Map<string, SafeResourceUrl>();
  constructor(private sanitizer: DomSanitizer) {}
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
  jump(event: Event, id: string): void {
    event.preventDefault();
    this.activeHeading=id;
    document.getElementById(id)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
}

export { UiIconComponent } from './ui-icon.component';
