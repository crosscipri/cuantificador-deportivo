"""Explicit UTC alignment, without elastic alignment or automatic lag removal."""
import numpy as np


def sample(series, grid, offset=0, interpolation="NONE", max_gap=5):
    times = np.round(np.asarray(series.index, dtype=float) + offset,6)
    values = np.asarray(series.values, dtype=float)
    out = np.full(len(grid), np.nan)
    observed = np.zeros(len(grid), dtype=bool)
    if not len(times):
        return out, observed
    right = np.searchsorted(times, grid)
    inside = right < len(times)
    exact = inside & (times[np.minimum(right, len(times)-1)] == grid)
    out[exact] = values[right[exact]]
    observed[exact] = np.isfinite(out[exact])
    if interpolation == "LINEAR":
        candidates = (~exact) & (right > 0) & (right < len(times))
        indices = np.flatnonzero(candidates)
        r = right[indices]
        lengths = times[r]-times[r-1]
        ok = (lengths <= max_gap) & np.isfinite(values[r-1]) & np.isfinite(values[r])
        indices, r, lengths = indices[ok], r[ok], lengths[ok]
        out[indices] = values[r-1] + (values[r]-values[r-1])*(grid[indices]-times[r-1])/lengths
    return out, observed


def display_indices(arrays, budget=2500):
    """Display reduction with bucket extrema and every gap boundary."""
    n = len(arrays[0])
    indices = set(np.linspace(0, n-1, min(n, budget), dtype=int).tolist())
    for values in arrays:
        valid = np.isfinite(values)
        transitions = np.flatnonzero(valid[1:] != valid[:-1])
        indices.update(transitions.tolist())
        indices.update((transitions+1).tolist())
        step = max(1, int(np.ceil(n / max(1, budget//2))))
        for start in range(0, n, step):
            part = values[start:start+step]
            if np.isfinite(part).any():
                indices.add(start+int(np.nanargmin(part)))
                indices.add(start+int(np.nanargmax(part)))
    return np.asarray(sorted(indices), dtype=int)


def json_values(values):
    return [float(v) if np.isfinite(v) else None for v in values]
