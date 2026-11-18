import assert from 'node:assert/strict';
import { boxPlotStats, formatEs, mergeStats, percentAtLeast, statsFromPoints, usableCorrelation } from '../src/app/shared/comparison-total-charts/comparison-total-charts';
import { DEVICE_COLORS, deviceColor, devicePointStyle } from '../src/app/models/comparison.model';

{
  assert.deepEqual(DEVICE_COLORS, ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#56B4E9', '#E69F00']);
  assert.equal(deviceColor('whoop-1'), deviceColor('whoop-1'));
  assert.equal(devicePointStyle('whoop-1'), devicePointStyle('whoop-1'));
  const styles = ['a', 'b', 'c', 'd'].map(devicePointStyle);
  assert.equal(new Set(styles).size, 4);
}

{
  const points = [
    { x: 100, y: 102 },
    { x: 110, y: 108 },
    { x: 120, y: 123 },
    { x: 130, y: 129 },
  ];
  const stats = statsFromPoints(points);
  const diffs = [2, -2, 3, -1];
  const bias = diffs.reduce((s, v) => s + v, 0) / 4;
  const mae = diffs.map(Math.abs).reduce((s, v) => s + v, 0) / 4;
  const rmse = Math.sqrt(diffs.map((d) => d * d).reduce((s, v) => s + v, 0) / 4);
  assert.equal(stats.n, 4);
  assert.ok(stats.r != null && stats.r > 0.98);
  assert.ok(Math.abs(stats.mae! - mae) < 1e-12);
  assert.ok(Math.abs(stats.rmse! - rmse) < 1e-12);
  assert.ok(Math.abs(stats.bias! - bias) < 1e-12);
  assert.equal(formatEs(0.9874, 3), '0,987');
  assert.equal(formatEs(-4.26, 1), '-4,3');
  assert.equal(formatEs(null, 1), 'Sin datos');
}

{
  const points = [{ x: 80, y: 84 }, { x: 90, y: 91 }, { x: 100, y: 97 }];
  const merged = mergeStats(points, { r: 0.91, bias: 0.5 });
  assert.equal(merged.r, 0.91);
  assert.equal(merged.bias, 0.5);
  assert.ok(merged.mae != null && merged.rmse != null);
  assert.equal(statsFromPoints([]).n, 0);
  assert.equal(statsFromPoints([{ x: 1, y: 2 }]).r, null);
}

// False r=0 (old NaN fallback with a high CCC) must not enter Perc or the boxes.
{
  assert.equal(usableCorrelation(0, 0.9904), false);
  assert.equal(usableCorrelation(0.9928, 0.9904), true);
  assert.equal(usableCorrelation(null), false);
  assert.equal(usableCorrelation(0, 0.02), true); // a genuine ~0 with a tiny CCC is allowed
  const values = [0.9977, 0.9928, 0.9875, 0.9951, 0.9933];
  assert.equal(percentAtLeast(values, 0.95), 100);
  assert.equal(percentAtLeast([...values, 0], 0.95), 100 * 5 / 6);
  const box = boxPlotStats(values)!;
  assert.ok(box.median > 0.99);
  assert.ok(box.whiskerLow <= box.q1 && box.whiskerHigh >= box.q3);
}

console.log('Total correlation chart helpers passed');
