import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

const ICON_PATHS = {
  'arrow-up-right': 'M6 18 18 6M6 6h12v12',
  'arrow-right': 'M4 12h16m-6-6 6 6-6 6',
  'arrow-left': 'M20 12H4m6-6-6 6 6 6',
  'arrow-down-right': 'm6 6 12 12M6 18h12V6',
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-up': 'm6 15 6-6 6 6',
  compare: 'M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM16 16l5 5',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  refresh: 'M4 10a8 8 0 1 1 1 7M4 4v6h6',
  menu: 'M4 6h16M4 12h16M4 18h16',
  copy: 'M9 9h11v11H9ZM15 9V4H4v11h5',
  play: 'm8 5 11 7-11 7Z',
} as const;
export type UiIconName = keyof typeof ICON_PATHS;

/** Decorative icons share a fixed view box; the parent control owns its accessible name. */
@Component({
  selector: 'svg[appIcon]',
  standalone: true,
  template: '<svg:path [attr.d]="paths[appIcon]" />',
  host: {
    viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round',
    'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false',
  },
  styles: ':host{display:inline-block;width:var(--icon-size,16px);height:var(--icon-size,16px);min-width:var(--icon-size,16px);flex-shrink:0;vertical-align:-.2em;pointer-events:none;overflow:visible}',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiIconComponent {
  @Input() appIcon: UiIconName = 'arrow-up-right';
  readonly paths = ICON_PATHS;
}
