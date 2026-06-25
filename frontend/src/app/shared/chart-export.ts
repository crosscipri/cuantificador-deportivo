/** Resolution used by every client-side chart PNG export. */
export const CHART_EXPORT_PIXEL_RATIO = 4;

type ExportableChart = {
  canvas: HTMLCanvasElement;
  options: { devicePixelRatio?: number };
  resize(): void;
};

/**
 * Re-renders a Chart.js chart at the same high resolution used by nocturnal HRV,
 * then runs the supplied export function while that render is active.
 */
export function withHighResolutionChartExport(
  chart: ExportableChart,
  exportPng: (canvas: HTMLCanvasElement) => void,
): void {
  const originalPixelRatio = chart.options.devicePixelRatio ?? window.devicePixelRatio ?? 1;

  try {
    chart.options.devicePixelRatio = CHART_EXPORT_PIXEL_RATIO;
    chart.resize();
    exportPng(chart.canvas);
  } finally {
    chart.options.devicePixelRatio = originalPixelRatio;
    chart.resize();
  }
}

/** Downloads a canvas with an opaque white background. */
export function downloadCanvasPng(canvas: HTMLCanvasElement, filename: string): void {
  const output = document.createElement('canvas');
  output.width = canvas.width;
  output.height = canvas.height;
  const context = output.getContext('2d')!;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, output.width, output.height);
  context.drawImage(canvas, 0, 0);

  const link = document.createElement('a');
  link.href = output.toDataURL('image/png');
  link.download = filename;
  link.click();
}
