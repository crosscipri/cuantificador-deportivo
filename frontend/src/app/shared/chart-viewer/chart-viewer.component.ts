import { Component, Input, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
  selector: 'app-chart-viewer',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule, MatTooltipModule],
  templateUrl: './chart-viewer.component.html',
  styleUrls: ['./chart-viewer.component.scss'],
})
export class ChartViewerComponent {
  @Input() chartB64 = '';
  @Input() title    = 'Gráfica';
  @Input() filename = 'chart.png';

  get imgSrc(): string {
    return `data:image/png;base64,${this.chartB64}`;
  }

  download(): void {
    const a = document.createElement('a');
    a.href     = this.imgSrc;
    a.download = this.filename;
    a.click();
  }

  openFull(): void {
    const w = window.open();
    if (w) {
      w.document.write(`
        <html>
          <head><title>${this.title}</title>
          <style>body{margin:0;background:#0f1117;display:flex;align-items:center;justify-content:center;min-height:100vh;}
          img{max-width:100%;height:auto;}</style></head>
          <body><img src="${this.imgSrc}" alt="${this.title}"></body>
        </html>`);
    }
  }
}
