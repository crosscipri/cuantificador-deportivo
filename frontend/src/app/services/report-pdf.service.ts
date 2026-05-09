import { Injectable } from '@angular/core';
import { jsPDF } from 'jspdf';
import { Session, AiAnalysis } from '../models/session.model';

// ─── palette ─────────────────────────────────────────────────────────────────
const C = {
  black:   [17,  24,  39]  as [number,number,number],
  ink2:    [75,  85,  99]  as [number,number,number],
  ink3:    [156, 163, 175] as [number,number,number],
  accent:  [59,  130, 246] as [number,number,number],
  green:   [16,  185, 129] as [number,number,number],
  amber:   [245, 158, 11]  as [number,number,number],
  red:     [239, 68,  68]  as [number,number,number],
  lineBg:  [243, 244, 246] as [number,number,number],
  white:   [255, 255, 255] as [number,number,number],
};

const calColor = (cal: string): [number,number,number] => ({
  excelente: C.green,
  bueno:     C.accent,
  moderado:  C.amber,
  deficiente: C.red,
}[cal] ?? C.ink2);

@Injectable({ providedIn: 'root' })
export class ReportPdfService {

  download(session: Session, analysis: AiAnalysis): void {
    const doc  = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const W    = doc.internal.pageSize.getWidth();   // 210
    const H    = doc.internal.pageSize.getHeight();  // 297
    const L    = 14;   // left margin
    const R    = W - L;
    const TW   = R - L;
    let   y    = 0;

    // ── helpers ──────────────────────────────────────────────────────────────

    const newPage = () => {
      doc.addPage();
      y = 14;
    };

    const guard = (needed: number) => { if (y + needed > H - 14) newPage(); };

    const setFont = (style: 'normal'|'bold', size: number, color = C.black) => {
      doc.setFont('helvetica', style);
      doc.setFontSize(size);
      doc.setTextColor(...color);
    };

    const wrap = (text: string, maxW: number): string[] =>
      doc.splitTextToSize(String(text ?? ''), maxW);

    const textBlock = (
      label: string, body: string,
      opts: { labelColor?: [number,number,number]; bodyColor?: [number,number,number]; indent?: number } = {}
    ) => {
      const ix = L + (opts.indent ?? 0);
      const tw = TW - (opts.indent ?? 0);
      if (label) {
        setFont('bold', 8, opts.labelColor ?? C.ink3);
        guard(6);
        doc.text(label.toUpperCase(), ix, y);
        y += 4.5;
      }
      setFont('normal', 9.5, opts.bodyColor ?? C.black);
      const lines = wrap(body, tw);
      guard(lines.length * 4.8 + 2);
      doc.text(lines, ix, y);
      y += lines.length * 4.8 + 3;
    };

    const sectionTitle = (title: string, color = C.accent) => {
      guard(12);
      y += 3;
      doc.setFillColor(...color);
      doc.rect(L, y - 4, 3, 6, 'F');
      setFont('bold', 11, C.black);
      doc.text(title, L + 5, y);
      y += 5;
      setFont('normal', 9, C.ink3);
      doc.setDrawColor(...C.lineBg);
      doc.line(L, y, R, y);
      y += 4;
    };

    const divider = () => {
      guard(6);
      doc.setDrawColor(...C.lineBg);
      doc.line(L, y, R, y);
      y += 5;
    };

    const calBadge = (cal: string, x: number, badgeY: number) => {
      const col = calColor(cal);
      doc.setFillColor(...col);
      doc.roundedRect(x, badgeY - 4.5, 28, 7, 1.5, 1.5, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(...C.white);
      doc.text(cal.toUpperCase(), x + 14, badgeY, { align: 'center' });
    };

    // ── HEADER PAGE ──────────────────────────────────────────────────────────
    y = 18;

    // top accent bar
    doc.setFillColor(...C.accent);
    doc.rect(0, 0, W, 5, 'F');

    // title
    setFont('bold', 16, C.black);
    doc.text('Informe de Análisis IA', L, y);
    y += 8;

    setFont('normal', 10, C.ink2);
    const subtitle = `${session.device_name}  ·  ${session.reference_name}`;
    doc.text(subtitle, L, y);
    y += 5;

    setFont('normal', 9, C.ink3);
    const meta = [
      session.session_name,
      `Generado: ${new Date(analysis.generated_at).toLocaleString('es-ES')}`,
      `Modelo: ${analysis.model}`,
    ].filter(Boolean).join('   ·   ');
    doc.text(meta, L, y);
    y += 3;

    divider();

    // ── VEREDICTO BANNER ─────────────────────────────────────────────────────
    const v = analysis.report.veredicto_sesion;
    if (v) {
      guard(22);
      const col = calColor(v.calificacion);
      doc.setFillColor(col[0], col[1], col[2], 0.08);
      doc.setDrawColor(...col);
      doc.roundedRect(L, y, TW, 22, 2, 2, 'FD');

      setFont('bold', 7, C.ink3);
      doc.text('VEREDICTO DE SESIÓN', L + 4, y + 5.5);

      setFont('bold', 12, C.black);
      doc.text(v.etiqueta ?? '', L + 4, y + 12);

      setFont('normal', 8.5, C.ink2);
      const pqLines = wrap(v.para_quien ?? '', TW - 36);
      doc.text(pqLines, L + 4, y + 17);

      calBadge(v.calificacion, R - 32, y + 12);

      y += 27;
    }

    // ── INFORME SECTIONS ─────────────────────────────────────────────────────
    const inf = analysis.report.informe;

    if (inf.resumen_ejecutivo) {
      sectionTitle('Resumen ejecutivo');
      textBlock('', inf.resumen_ejecutivo);
    }

    if (inf.validez_general) {
      sectionTitle('Validez general · CCC / ICC / r');
      textBlock('', inf.validez_general);
    }

    // Bland-Altman
    if (inf.bland_altman) {
      sectionTitle('Análisis Bland–Altman');
      if (typeof inf.bland_altman === 'object') {
        textBlock('Visual', inf.bland_altman.descripcion_visual ?? '');
        if (inf.bland_altman.sesgo_proporcional)
          textBlock('Sesgo proporcional', inf.bland_altman.sesgo_proporcional, { labelColor: C.amber });
        if (inf.bland_altman.interpretacion_canal)
          textBlock('Para el vídeo', inf.bland_altman.interpretacion_canal, { bodyColor: C.accent });
      } else {
        textBlock('', inf.bland_altman);
      }
    }

    // Series temporales
    if (inf.series_temporales) {
      sectionTitle('Series temporales');
      const st = inf.series_temporales;
      textBlock('Visual', st.descripcion_visual ?? '');
      if (st.fenomenos_identificados)
        textBlock('Fenómenos', st.fenomenos_identificados);
      if (st.interpretacion_canal)
        textBlock('Para el vídeo', st.interpretacion_canal, { bodyColor: C.accent });
    }

    // Scatter plot
    if (inf.scatter_plot) {
      sectionTitle('Dispersión · Scatter Plot');
      textBlock('Visual', inf.scatter_plot.descripcion_visual ?? '');
      if (inf.scatter_plot.patron_error)
        textBlock('Patrón de error', inf.scatter_plot.patron_error);
    }

    // Error por zonas
    if (inf.error_por_zonas && typeof inf.error_por_zonas === 'object') {
      const zones = Object.entries(inf.error_por_zonas as Record<string, any>);
      if (zones.length) {
        sectionTitle('Error por zonas de intensidad');
        for (const [key, zv] of zones) {
          guard(18);
          // zone pill
          const maeColor = zv.mae == null ? C.ink3
            : zv.mae <= 3 ? C.green : zv.mae <= 5 ? C.accent : zv.mae <= 10 ? C.amber : C.red;
          doc.setFillColor(...maeColor);
          doc.roundedRect(L, y - 3.5, 9, 5.5, 1, 1, 'F');
          setFont('bold', 7.5, C.white);
          doc.text(key, L + 4.5, y, { align: 'center' });

          setFont('bold', 9, C.black);
          const maeStr = zv.mae != null ? `${(+zv.mae).toFixed(1)} bpm` : '—';
          doc.text(maeStr, L + 12, y);

          setFont('normal', 8, C.ink2);
          doc.text(zv.valoracion ?? '', L + 28, y);
          y += 5;

          if (zv.explicacion_canal) {
            const lines = wrap(zv.explicacion_canal, TW - 12);
            setFont('normal', 8.5, C.ink2);
            guard(lines.length * 4.2 + 2);
            doc.text(lines, L + 12, y);
            y += lines.length * 4.2 + 1;
          }
          if (zv.causa_probable) {
            const lines = wrap(`Causa probable: ${zv.causa_probable}`, TW - 12);
            setFont('normal', 8, C.ink3);
            guard(lines.length * 4 + 3);
            doc.text(lines, L + 12, y);
            y += lines.length * 4 + 3;
          }
        }
      }
    }

    // Lag análisis
    if (inf.lag_analisis && typeof inf.lag_analisis === 'object') {
      sectionTitle('Lag temporal');
      const la = inf.lag_analisis as any;
      if (la.lag_estimado_segundos != null) {
        const lagStr = `Lag estimado: ${la.lag_estimado_segundos} s${la.es_problematico ? '  ·  ⚠ Problemático' : ''}`;
        textBlock('', lagStr, { bodyColor: la.es_problematico ? C.red : C.black });
      }
      if (la.causa_del_lag)
        textBlock('Causa del lag', la.causa_del_lag);
      if (la.explicacion_canal)
        textBlock('Para el vídeo', la.explicacion_canal, { bodyColor: C.accent });
    } else if (inf.lag_analisis) {
      sectionTitle('Lag temporal');
      textBlock('', String(inf.lag_analisis));
    }

    // Diagnóstico de causas
    if (inf.diagnostico_causas) {
      sectionTitle('Diagnóstico de causas de error', C.amber);
      textBlock('', inf.diagnostico_causas);
    }

    // Recomendación
    if (inf.recomendacion_practica) {
      sectionTitle('Recomendación práctica', C.green);
      textBlock('', inf.recomendacion_practica);
      if (v?.NO_recomendado_para)
        textBlock('NO recomendado para', v.NO_recomendado_para, { labelColor: C.red, bodyColor: C.red });
    }

    // ── ANOTACIONES TEMPORALES ───────────────────────────────────────────────
    const anns = analysis.report.anotaciones_temporales ?? [];
    if (anns.length) {
      sectionTitle('Momentos anotados por IA');
      for (const ann of anns) {
        guard(20);
        const t0 = ann.tiempo_inicio;
        const t1 = ann.tiempo_fin;
        const timeStr = `${Math.floor(t0/60)}:${String(t0%60).padStart(2,'0')} – ${Math.floor(t1/60)}:${String(t1%60).padStart(2,'0')}`;
        const sevColor = { leve: C.amber, moderada: C.amber, severa: C.red }[ann.severidad] ?? C.ink3;

        setFont('bold', 8.5, C.black);
        doc.text(`${ann.tipo.replace(/_/g, ' ').toUpperCase()}`, L, y);
        setFont('normal', 8, C.ink3);
        doc.text(timeStr, L + 50, y);
        setFont('bold', 7.5, sevColor);
        doc.text(ann.severidad.toUpperCase(), R - doc.getTextWidth(ann.severidad.toUpperCase()), y);
        y += 5;

        const descLines = wrap(ann.descripcion, TW - 4);
        setFont('normal', 8.5, C.ink2);
        guard(descLines.length * 4.2 + 2);
        doc.text(descLines, L + 4, y);
        y += descLines.length * 4.2 + 1;

        if (ann.causa) {
          const causaLines = wrap(`Causa: ${ann.causa}`, TW - 4);
          setFont('normal', 8, C.ink3);
          guard(causaLines.length * 4 + 3);
          doc.text(causaLines, L + 4, y);
          y += causaLines.length * 4 + 3;
        }

        if (ann.frase_para_video) {
          const fvLines = wrap(`Para el vídeo: "${ann.frase_para_video}"`, TW - 4);
          setFont('normal', 8, C.accent);
          guard(fvLines.length * 4 + 4);
          doc.text(fvLines, L + 4, y);
          y += fvLines.length * 4 + 5;
        }

        doc.setDrawColor(...C.lineBg);
        doc.line(L, y - 2, R, y - 2);
      }
    }

    // ── FOOTER on every page ─────────────────────────────────────────────────
    const totalPages = (doc.internal as any).getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      doc.setFillColor(...C.lineBg);
      doc.rect(0, H - 9, W, 9, 'F');
      setFont('normal', 7.5, C.ink3);
      doc.text(`El Cuantificador Deportivo  ·  ${session.device_name} vs ${session.reference_name}`, L, H - 3.5);
      doc.text(`${p} / ${totalPages}`, R, H - 3.5, { align: 'right' });
    }

    // ── SAVE ────────────────────────────────────────────────────────────────
    const filename = [
      'informe',
      (session.device_name ?? 'dispositivo').replace(/\s+/g, '-'),
      (session.session_name ?? '').replace(/\s+/g, '-'),
    ].filter(Boolean).join('_') + '.pdf';

    doc.save(filename);
  }
}
