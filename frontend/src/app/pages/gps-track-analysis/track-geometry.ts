// IAAF/World Athletics 400 m standard track geometry.
// Lane 1 inside (kerb) radius = 36.50 m. Running line is 30 cm out.
// Each straight = 84.39 m. Lane width = 1.22 m.
// Total lane-1 lap (running line) = 2×84.39 + 2π×36.80 = 400.00 m.

export const STRAIGHT = 84.39;
export const R_INNER  = 36.50;
export const LANE_W   = 1.22;
export const N_LANES  = 8;

export function runRadius(n: number): number {
  return R_INNER + (n - 1) * LANE_W + (n === 1 ? 0.30 : 0.20);
}

export function trackBbox() {
  const ro = R_INNER + N_LANES * LANE_W;
  return { minX: -STRAIGHT / 2 - ro, maxX: STRAIGHT / 2 + ro, minY: -ro, maxY: ro };
}

export function lapLength(n: number): number {
  return 2 * STRAIGHT + 2 * Math.PI * runRadius(n);
}

// SVG path for a closed oval at given radius (Y-flipped inside a scale(1,-1) group).
export function pathEdge(r: number): string {
  const L = STRAIGHT;
  const f = (n: number) => n.toFixed(3);
  return `M ${f(L/2)} ${f(-r)} A ${r} ${r} 0 0 1 ${f(L/2)} ${f(r)} L ${f(-L/2)} ${f(r)} A ${r} ${r} 0 0 1 ${f(-L/2)} ${f(-r)} Z`;
}

// Point on lane n's running line at arc distance d (CCW from bottom-right).
// Returns [x, y, tangentAngle] in math coords (Y up).
export function pointAt(n: number, d: number): [number, number, number] {
  const r  = runRadius(n);
  const Lc = Math.PI * r;
  const Ls = STRAIGHT;
  const tot = 2 * Ls + 2 * Lc;
  let dd = ((d % tot) + tot) % tot;

  if (dd < Lc) {
    const a = -Math.PI / 2 + dd / r;
    return [Ls / 2 + r * Math.cos(a), r * Math.sin(a), a + Math.PI / 2];
  }
  dd -= Lc;
  if (dd < Ls) return [Ls / 2 - dd, r, Math.PI];
  dd -= Ls;
  if (dd < Lc) {
    const a = Math.PI / 2 + dd / r;
    return [-Ls / 2 + r * Math.cos(a), r * Math.sin(a), a + Math.PI / 2];
  }
  dd -= Lc;
  return [-Ls / 2 + dd, -r, 0];
}
