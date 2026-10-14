import { UiIconComponent } from './ui-icon.component';
import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SCORE_DIMENSIONS, reviewScoreSummary } from './review-scores';

@Component({
  selector:'app-review-verdict',standalone:true,imports: [UiIconComponent, CommonModule],
  template:`<div class="conclusion-grid" *ngIf="verdict as v">
    <div class="conclusion-main">
      <h2>{{v.title || 'Nuestra conclusión'}}</h2>
      <div class="rating-overview">
        <div class="rating-badge" [class.unrated]="score.total == null">
          <span class="rating-number">{{score.total == null ? '—' : (score.total | number:'1.0-1')}}</span>
          <span>{{score.total == null ? 'Sin evaluar' : score.count === 4 ? 'Puntuación global' : 'Puntuación parcial'}}</span>
          <small *ngIf="score.total != null">sobre 100</small>
        </div>
        <dl class="rating-breakdown">
          <div *ngFor="let d of dimensions" [attr.data-score]="d.key"><dt>{{d.label}}</dt>
            <dd [class.missing]="v.scores?.[d.key] == null">{{v.scores?.[d.key] == null ? 'Sin evaluar' : (v.scores[d.key] | number:'1.0-1')}}</dd>
          </div>
        </dl>
      </div>
      <p class="rating-context" *ngIf="score.count">Media de {{score.count}} de 4 áreas evaluadas, con el mismo peso.</p>
      <p class="rating-source" *ngIf="v.scores?.source === 'device'">Puntuaciones de {{v.scores.source_device_name}}.</p>
      <p class="rating-source" *ngIf="v.scores?.source === 'editorial' && score.count">Puntuaciones editoriales.</p>
      <p class="conclusion-text" *ngIf="v.text">{{v.text}}</p>
      <p *ngIf="v.recommended"><strong>Para quién:</strong> {{v.recommended}}</p>
      <p *ngIf="v.not_recommended"><strong>Para quién no:</strong> {{v.not_recommended}}</p>
    </div>
    <div class="conclusion-lists" *ngIf="v.pros?.length || v.cons?.length">
      <div class="pros" *ngIf="v.pros?.length">
        <h3><span class="list-icon" aria-hidden="true"><svg appIcon="check"></svg></span> Pros</h3>
        <ul><li *ngFor="let item of v.pros">{{item}}</li></ul>
      </div>
      <div class="cons" *ngIf="v.cons?.length">
        <h3><span class="list-icon" aria-hidden="true"><svg appIcon="close"></svg></span> Contras</h3>
        <ul><li *ngFor="let item of v.cons">{{item}}</li></ul>
      </div>
    </div>
  </div>`,
  styles:[`
    :host {display:block;min-width:0;container-type:inline-size;container-name:verdict}
    .conclusion-grid {display:grid;gap:28px;padding:28px 0;border-top:1px solid var(--line,#e3e3e3);border-bottom:1px solid var(--line,#e3e3e3);font-size:15px;line-height:1.7}
    .conclusion-main,.conclusion-lists {min-width:0}
    .conclusion-grid h2,.conclusion-grid h3 {font-family:var(--font-display,sans-serif);font-size:26px;font-weight:500;letter-spacing:-.035em;line-height:1.2;margin:0 0 18px;padding:0;border:0}
    .conclusion-grid h3 {display:flex;align-items:center;gap:8px;font-size:24px;margin:0 0 10px}
    .rating-overview {display:grid;grid-template-columns:112px minmax(0,1fr);gap:16px;align-items:stretch}
    .rating-badge {display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:16px 8px;background:var(--accent,#0055ff);color:white;text-align:center;font-size:12px;line-height:1.35}
    .rating-badge.unrated {background:var(--surface-2,#f7f7f7);color:var(--ink-3,#505050);border:1px solid var(--line,#ddd)}
    .rating-number {font:600 36px/1.1 var(--font-display,sans-serif);letter-spacing:-.035em}
    .rating-badge small {font-size:11px}
    .rating-breakdown {margin:0;min-width:0;font-size:13px}
    .rating-breakdown>div {display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:34px;border-bottom:1px solid var(--line,#e3e3e3)}
    .rating-breakdown>div:last-child {border-bottom:0}
    dd {margin:0;font-weight:600;color:var(--accent,#0055ff);text-align:right}
    dd.missing {font-size:11px;font-weight:400;color:var(--ink-3,#505050)}
    p {margin:16px 0 0}
    .rating-context,.rating-source {font-size:12px;line-height:1.5;color:var(--ink-3,#505050);margin-top:10px}
    .rating-source {margin-top:4px}
    .conclusion-text {white-space:pre-line}
    .conclusion-lists {display:flex;flex-direction:column;gap:26px}
    ul {margin:0;padding-left:20px}
    li {padding-left:2px;margin-bottom:7px}
    .list-icon {display:inline-grid;place-items:center;width:23px;height:23px;border-radius:50%;background:#187c42;color:white;font:bold 17px/1 sans-serif;flex-shrink:0}
    .cons .list-icon {background:#c52a30}
    @container verdict (min-width:700px) {.conclusion-grid {grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:32px}}
    @container verdict (max-width:340px) {.rating-overview {grid-template-columns:96px minmax(0,1fr);gap:10px}.rating-breakdown {font-size:12px}.rating-number {font-size:32px}}
  `],
})
export class ReviewVerdictComponent {
  @Input() verdict:any;
  readonly dimensions=SCORE_DIMENSIONS;
  get score(){return reviewScoreSummary(this.verdict?.scores);}
}
