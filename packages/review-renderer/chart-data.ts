// Retain original, aligned pairs: no averages or independently sampled curves.
export function pairedIndices(time: number[], series: any[], start: number, end: number, budget: number): number[] {
  const visible = time.flatMap((t, i) => Number.isFinite(t) && t >= start && t <= end ? [i] : []);
  if (visible.length <= budget) return visible;
  const selected = new Set<number>([visible[0], visible[visible.length - 1]]);
  const signals = series.map(s => s.values as (number | null)[]);
  const device = series.find(s => s.role === 'device')?.values;
  const reference = series.find(s => s.role === 'reference')?.values;
  if (device && reference) signals.push(time.map((_, i) => finite(device[i]) && finite(reference[i]) ? device[i] - reference[i] : null));
  const size = Math.max(1, Math.ceil(visible.length / Math.max(1, Math.floor(budget / (2 + signals.length * 2)))));
  for (let offset = 0; offset < visible.length; offset += size) {
    const chunk = visible.slice(offset, offset + size);
    selected.add(chunk[0]); selected.add(chunk[chunk.length - 1]);
    for (const values of signals) {
      let low = -1, high = -1;
      for (const i of chunk) {
        if (!finite(values[i])) continue;
        if (low < 0 || values[i]! < values[low]!) low = i;
        if (high < 0 || values[i]! > values[high]!) high = i;
      }
      if (low >= 0) { selected.add(low); selected.add(high); }
    }
  }
  // Keep both edges of missing runs; never join over a removed null sample.
  for (let j = 1; j < visible.length; j++) {
    const i = visible[j], previous = visible[j - 1];
    if (signals.some(values => finite(values[i]) !== finite(values[previous]))) {
      selected.add(previous); selected.add(i);
    }
  }
  return [...selected].sort((a, b) => a - b);
}
export function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
export function elapsed(seconds: number): string {
  const sign = seconds < 0 ? '−' : '';
  const s = Math.round(Math.abs(seconds));
  return sign + (s >= 3600 ? Math.floor(s / 3600) + ':' : '') + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
export function pairAt(e: any, index: number) {
  const device = e.series?.find((s:any)=>s.role==='device')?.values?.[index];
  const reference = e.series?.find((s:any)=>s.role==='reference')?.values?.[index];
  return { time:e.time[index], device:finite(device)?device:null, reference:finite(reference)?reference:null,
    difference:finite(device)&&finite(reference)?device-reference:null };
}

// Pick an original timestamp, including missing pairs, inside the displayed interval.
export function nearestTimeIndex(time: number[], target: number, start: number, end: number): number {
  const bound = (value: number, after = false): number => {
    let low = 0, high = time.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (time[mid] < value || (after && time[mid] === value)) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  if (!finite(target) || start > end) return -1;
  const first = bound(start), last = bound(end, true) - 1;
  if (first > last) return -1;
  const right = Math.max(first, Math.min(last, bound(target)));
  return right > first && Math.abs(time[right - 1] - target) <= Math.abs(time[right] - target) ? right - 1 : right;
}

// A common domain prevents the identity line from implying different units on each axis.
export function identityReference(points: {x:number;y:number}[]) {
  let min=Infinity, max=-Infinity;
  for (const p of points) {
    if (!finite(p.x) || !finite(p.y)) continue;
    min=Math.min(min,p.x,p.y); max=Math.max(max,p.x,p.y);
  }
  if (!finite(min) || !finite(max)) return null;
  const padding=Math.max((max-min)*.06,Math.abs(max)*.01,1);
  min=Math.floor(min-padding); max=Math.ceil(max+padding);
  return {min,max,data:[{x:min,y:min},{x:max,y:max}]};
}
