import { Component, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { extractHeartRate, extractHrv, extractSleepIntervals, formatFitTimestamp, HeartRateRow, HrvRow, parseFit, SleepInterval } from './garmin-fit-parser';

type ToolTab = 'fc' | 'hrv';
type StatusType = '' | 'success' | 'error';
interface Status { text: string; type: StatusType; }
interface Stats { count: number; min: string; avg: string; max: string; }

@Component({
  selector: 'app-tools', standalone: true, imports: [CommonModule, FormsModule],
  templateUrl: './tools.component.html', styleUrls: ['./tools.component.scss'],
})
export class ToolsComponent implements OnDestroy {
  tab: ToolTab = 'fc';
  fcFiles: File[] = []; hrvFiles: File[] = [];
  fcStatus: Status = { text: 'Todavía no se han seleccionado archivos.', type: '' };
  hrvStatus: Status = { text: 'Todavía no se ha seleccionado ningún HRV_STATUS.fit.', type: '' };
  processingFc = false; processingHrv = false;
  nights: SleepInterval[] = []; selectedNight = 0; private heartRateRows: HeartRateRow[] = [];
  fcRows: HeartRateRow[] = []; hrvRows: HrvRow[] = [];
  fcStats?: Stats; hrvStats?: Stats;
  fcUrl?: string; hrvUrl?: string; fcFileName = ''; hrvFileName = '';

  addFiles(kind: ToolTab, input: FileList | null): void {
    if (!input) return;
    const current = kind === 'fc' ? this.fcFiles : this.hrvFiles;
    const merged = new Map(current.map(f => [`${f.name}:${f.size}:${f.lastModified}`, f]));
    [...Array.from(input)].filter(f => f.name.toLowerCase().endsWith('.fit')).forEach(f => merged.set(`${f.name}:${f.size}:${f.lastModified}`, f));
    if (kind === 'fc') { this.fcFiles = [...merged.values()]; this.resetFcResult(); this.fcStatus = { text: this.fcSelectionText(), type: '' }; }
    else { this.hrvFiles = [...merged.values()]; this.resetHrvResult(); this.hrvStatus = { text: `${this.hrvFiles.length} archivo(s) seleccionado(s): ${this.hrvFiles.filter(f => f.name.toUpperCase().includes('HRV_STATUS')).length} HRV_STATUS.`, type: '' }; }
  }

  drop(event: DragEvent, kind: ToolTab): void { event.preventDefault(); this.addFiles(kind, event.dataTransfer?.files ?? null); }
  classify(name: string, kind: ToolTab): string { const n = name.toUpperCase(); return kind === 'hrv' ? (n.includes('HRV_STATUS') ? 'VFC nocturna' : 'FIT') : n.includes('SLEEP_DATA') ? 'Sueño' : n.includes('WELLNESS') ? 'Bienestar / FC' : 'FIT'; }
  clear(kind: ToolTab): void {
    if (kind === 'fc') { this.fcFiles = []; this.resetFcResult(); this.fcStatus = { text: 'Todavía no se han seleccionado archivos.', type: '' }; }
    else { this.hrvFiles = []; this.resetHrvResult(); this.hrvStatus = { text: 'Todavía no se ha seleccionado ningún HRV_STATUS.fit.', type: '' }; }
  }

  async processFc(): Promise<void> {
    this.processingFc = true; this.resetFcResult(); this.fcStatus = { text: 'Procesando archivos FIT…', type: '' };
    try {
      const messages = (await Promise.all(this.fcFiles.map(async f => parseFit(await f.arrayBuffer(), f.name)))).flat();
      this.nights = extractSleepIntervals(messages); this.heartRateRows = extractHeartRate(messages);
      if (!this.nights.length) throw new Error('No se ha detectado ninguna sesión de sueño. Añade el SLEEP_DATA.fit correspondiente.');
      if (!this.heartRateRows.length) throw new Error('No se han detectado muestras de FC. Añade todos los WELLNESS.fit de la exportación.');
      this.fcStatus = { text: `${this.nights.length} noche(s) detectada(s) y ${this.heartRateRows.length} muestras de FC localizadas.`, type: 'success' };
      this.selectedNight = 0; this.generateFc();
    } catch (e) { this.fcStatus = { text: e instanceof Error ? e.message : String(e), type: 'error' }; }
    finally { this.processingFc = false; }
  }

  generateFc(): void {
    const night = this.nights[this.selectedNight]; if (!night) return;
    this.fcRows = this.heartRateRows.filter(r => r.fitTimestamp >= night.start && r.fitTimestamp <= night.end);
    if (!this.fcRows.length) { this.fcStatus = { text: 'No hay muestras de FC dentro de la noche seleccionada.', type: 'error' }; return; }
    const values = this.fcRows.map(r => r.heartRate); this.fcStats = this.stats(values, 'ppm', 0);
    const date = formatFitTimestamp(night.start).slice(0, 10); this.fcFileName = `garmin_fc_noche_${date}.csv`;
    this.fcUrl = this.csvUrl(['timestamp,fc_ppm', ...this.fcRows.map(r => `${formatFitTimestamp(r.fitTimestamp)},${r.heartRate}`)], this.fcUrl);
  }

  async processHrv(): Promise<void> {
    this.processingHrv = true; this.resetHrvResult(); this.hrvStatus = { text: 'Procesando HRV_STATUS.fit…', type: '' };
    try {
      const messages = (await Promise.all(this.hrvFiles.map(async f => parseFit(await f.arrayBuffer(), f.name)))).flat();
      this.hrvRows = extractHrv(messages);
      if (!this.hrvRows.length) throw new Error('No se han encontrado muestras nocturnas de VFC. Comprueba que has añadido un HRV_STATUS.fit válido.');
      const values = this.hrvRows.map(r => r.hrvMs); this.hrvStats = this.stats(values, 'ms', 1);
      const date = formatFitTimestamp(this.hrvRows[0].fitTimestamp).slice(0, 10); this.hrvFileName = `garmin_hrv_noche_${date}.csv`;
      this.hrvUrl = this.csvUrl(['timestamp,hrv_ms', ...this.hrvRows.map(r => `${formatFitTimestamp(r.fitTimestamp)},${r.hrvMs.toFixed(1)}`)], this.hrvUrl);
      this.hrvStatus = { text: `CSV preparado con ${this.hrvRows.length} muestras. UTC convertido correctamente a Europe/Madrid.`, type: 'success' };
    } catch (e) { this.hrvStatus = { text: e instanceof Error ? e.message : String(e), type: 'error' }; }
    finally { this.processingHrv = false; }
  }

  nightLabel(n: SleepInterval): string { return `${formatFitTimestamp(n.start)} → ${formatFitTimestamp(n.end)}`; }
  timestamp(n: number): string { return formatFitTimestamp(n); }
  private stats(v: number[], unit: string, decimals: number): Stats { return { count: v.length, min: `${Math.min(...v).toFixed(decimals)} ${unit}`, avg: `${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)} ${unit}`, max: `${Math.max(...v).toFixed(decimals)} ${unit}` }; }
  private csvUrl(lines: string[], old?: string): string { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })); }
  private fcSelectionText(): string { return `${this.fcFiles.length} archivo(s) seleccionado(s): ${this.fcFiles.filter(f => f.name.toUpperCase().includes('WELLNESS')).length} WELLNESS y ${this.fcFiles.filter(f => f.name.toUpperCase().includes('SLEEP_DATA')).length} SLEEP_DATA.`; }
  private resetFcResult(): void { this.nights = []; this.heartRateRows = []; this.fcRows = []; this.fcStats = undefined; if (this.fcUrl) URL.revokeObjectURL(this.fcUrl); this.fcUrl = undefined; }
  private resetHrvResult(): void { this.hrvRows = []; this.hrvStats = undefined; if (this.hrvUrl) URL.revokeObjectURL(this.hrvUrl); this.hrvUrl = undefined; }
  ngOnDestroy(): void { if (this.fcUrl) URL.revokeObjectURL(this.fcUrl); if (this.hrvUrl) URL.revokeObjectURL(this.hrvUrl); }
}
