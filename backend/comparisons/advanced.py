"""Descriptive diagnostics on analytical pairs, independent of render reduction."""
import numpy as np
from .statistics import paired_metrics, gap_stats


def eligibility(times, exclusions):
    eligible = np.ones(len(times), dtype=bool)
    for interval in exclusions:
        eligible &= ~((times >= interval.start_sec) & (times < interval.end_sec))
    return eligible


def masked_metrics(reference, device, eligible, step=1):
    result = paired_metrics(reference[eligible], device[eligible],step)
    valid = np.isfinite(reference) & np.isfinite(device)
    # Exclusions break gaps; deleting them would join unrelated missing periods.
    result.update(gap_stats(valid | ~eligible,step))
    result.update(planned_pairs=len(reference), excluded_pairs=int((~eligible).sum()))
    return result


def lag_diagnostic(reference, device, eligible, max_seconds):
    limit = min(max_seconds, max(0, (len(reference)-60)//2))
    unavailable = {"lag_seconds": None, "r_zero": None, "r_max": None,
                   "n": 0, "search_max_seconds": limit,
                   "sign": "positive_device_delayed", "applied_to_signal": False}
    if not limit:
        return {**unavailable, "reason": "Se necesitan al menos 62 instantes para estimar lag."}
    indices = np.arange(limit, len(reference)-limit)
    shared = eligible[indices] & np.isfinite(reference[indices])
    for shift in range(-limit, limit+1):
        shared &= eligible[indices+shift] & np.isfinite(device[indices+shift])
    indices = indices[shared]
    if len(indices)<60 or np.std(reference[indices])<1:
        return {**unavailable, "n": len(indices), "reason": "Pares comunes o variación de referencia insuficientes."}
    x = reference[indices]
    correlations = []
    for shift in range(-limit, limit+1):
        y = device[indices+shift]
        correlations.append(float(np.corrcoef(x, y)[0, 1]) if np.std(y)>=1 else np.nan)
    if not np.isfinite(correlations).any():
        return {**unavailable, "n": len(indices), "reason": "Variación del dispositivo insuficiente."}
    best = int(np.nanargmax(correlations))
    return {**unavailable, "lag_seconds": best-limit, "r_zero": correlations[limit],
            "r_max": correlations[best], "n": len(indices), "boundary_peak": best in (0, 2*limit),
            "reason": None, "method": "pearson_fixed_common_pairs_integer_seconds"}


def diagnostics(reference, device, eligible, max_lag, sampling_hz=1):
    valid = eligible & np.isfinite(reference) & np.isfinite(device)
    x, y = reference[valid], device[valid]
    n = len(x)
    take = np.unique(np.r_[np.linspace(0, n-1, min(n, 1200), dtype=int),
                           [int(np.argmax(np.abs(y-x)))] if n else []]).astype(int)
    absolute = np.sort(np.abs(y-x))
    ranks = np.unique(np.linspace(0, n-1, min(n, 501), dtype=int))
    # CDF at each retained knot includes every tied observation.
    ecdf_x = np.unique(absolute[ranks]) if n else []
    return {"n": n, "display_n": len(take),
            "scatter": [{"x": float(x[i]), "y": float(y[i])} for i in take],
            "bland_altman": [{"x": float((x[i]+y[i])/2), "y": float(y[i]-x[i])} for i in take],
            "ecdf": [{"x": float(a), "y": float(np.searchsorted(absolute, a, side="right")/n*100)} for a in ecdf_x],
            "lag": {**lag_diagnostic(reference[::sampling_hz], device[::sampling_hz], eligible[::sampling_hz], max_lag),
                    "diagnostic_sampling_hz":1,"diagnostic_sampling":"exact_grid_subselection_no_interpolation"}}


def interval_metrics(reference, device, times, eligible, intervals, step=1):
    return [{"name": item.name, "start_sec": item.start_sec, "end_sec": item.end_sec,
             "metrics": masked_metrics(reference, device, eligible & (times>=item.start_sec) & (times<item.end_sec),step)}
            for item in intervals]


def intensity_metrics(reference, device, eligible, bounds,step=1):
    edges = [-np.inf, *bounds, np.inf]
    return [{"lower_bpm": a if np.isfinite(a) else None, "upper_bpm": b if np.isfinite(b) else None,
             "metrics": masked_metrics(reference, device, eligible & (reference>=a) & (reference<b),step)}
            for a, b in zip(edges, edges[1:])]


def transient_metrics(reference,device,times,eligible,intervals,options,hz=1):
    results=[]
    for interval in intervals:
        take=(times>=interval.start_sec)&(times<interval.end_sec)
        x,y,t,ok=reference[take],device[take],times[take],eligible[take]
        result={'name':interval.name,'delay_50_seconds':None,'delay_90_seconds':None,'overshoot_bpm':None,
                'end_undershoot_bpm':None,'reference_change_bpm':None,'reason':None,
                'method':'manual_interval_stable_5s_edges_sustained_threshold_v1','dwell_seconds':options.transient_dwell_seconds}
        results.append(result)
        edge=5*hz;dwell=options.transient_dwell_seconds*hz
        if len(x)<2*edge+dwell or not (np.all(ok[:edge]) and np.all(ok[-edge:]) and np.isfinite(x[:edge]).all() and np.isfinite(x[-edge:]).all()):
            result['reason']='Intervalo corto o extremos sin referencia completa.';continue
        baseline,target=float(np.median(x[:edge])),float(np.median(x[-edge:]));delta=target-baseline
        result['reference_change_bpm']=delta
        if abs(delta)<options.transient_min_change_bpm or np.std(x[:edge])>3 or np.std(x[-edge:])>3:
            result['reason']='Cambio insuficiente o extremos de referencia no estables (SD >3 bpm).';continue
        sign=1 if delta>0 else -1
        def crossing(values,threshold):
            condition=ok&np.isfinite(values)&(sign*(values-threshold)>=0)
            if condition[:edge].any():return None
            sustained=np.convolve(condition.astype(int),np.ones(dwell,dtype=int),'valid')
            matches=np.flatnonzero(sustained>=dwell)
            return float(t[matches[0]]) if len(matches) else None
        for percentage in (50,90):
            threshold=baseline+delta*percentage/100
            rt,dt=crossing(x,threshold),crossing(y,threshold)
            if rt is not None and dt is not None:result[f'delay_{percentage}_seconds']=dt-rt
        valid=ok&np.isfinite(y)
        if valid.any():result['overshoot_bpm']=float(max(0,np.max(sign*(y[valid]-target))))
        end=y[-edge:][ok[-edge:]&np.isfinite(y[-edge:])]
        if len(end)>=edge*.8:result['end_undershoot_bpm']=float(max(0,sign*(target-np.median(end))))
        if result['delay_50_seconds'] is None and result['delay_90_seconds'] is None:result['reason']='No hay cruces sostenidos identificables; no se inventa un tiempo de respuesta.'
    return results


def trend_metrics(reference,device,eligible,hz=1):
    span=5*hz
    slope=np.full(len(reference),np.nan)
    if len(reference)>2*span:
        valid=np.isfinite(reference[:-2*span])&np.isfinite(reference[2*span:])
        for offset in range(2*span+1):valid&=eligible[offset:offset+len(valid)]&np.isfinite(reference[offset:offset+len(valid)])
        slope[span:-span]=np.where(valid,(reference[2*span:]-reference[:-2*span])/10,np.nan)
    return [{'state':label,'slope_threshold_bpm_per_second':.5,'window_seconds':10,
             'metrics':masked_metrics(reference,device,eligible&mask,1/hz)}
            for label,mask in [('RISING',slope>.5),('STABLE',np.abs(slope)<=.5),('FALLING',slope<-.5)]]
