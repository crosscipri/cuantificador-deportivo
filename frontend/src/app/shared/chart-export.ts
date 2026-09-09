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

/** Letterbox a scientific figure into a fixed 16:9 publication frame. */
export function downloadCanvasFramePng(canvas:HTMLCanvasElement,width:number,height:number,filename:string,title:string):void {
  const output=document.createElement('canvas');output.width=width;output.height=height;
  const ctx=output.getContext('2d')!;const margin=width/40;
  ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);ctx.fillStyle='#18181b';ctx.font=`600 ${width/60}px sans-serif`;
  ctx.fillText(title,margin,margin*1.4,width-2*margin);
  const factor=Math.min((width-2*margin)/canvas.width,(height-4*margin)/canvas.height);
  const w=canvas.width*factor,h=canvas.height*factor;
  ctx.drawImage(canvas,(width-w)/2,(height-h)/2,w,h);
  ctx.font=`${width/110}px sans-serif`;ctx.fillText('Comparativa descriptiva · consultar selección, referencias y metodología de la evidencia exportada.',margin,height-margin,width-2*margin);
  downloadCanvasPng(output,filename);
}
