"""Units and labels are defined by metric semantics, never guessed from values."""
from .statistics import METRICS

GPS_METRICS={
    'derived_distance_m':('Distancia derivada actual','m'),
    'legacy_derived_distance_m':('Distancia derivada histórica','m'),
    'distance_error_m':('Diferencia de distancia respecto a referencia','m'),
    'distance_error_percent':('Diferencia de distancia','%'),
    'cross_track_mean_m':('Separación media a la polilínea','m'),
    'cross_track_p95_m':('P95 de separación a la polilínea','m'),
    'cross_track_max_m':('Máxima separación a la polilínea','m'),
    'geometry_n':('Puntos con proyección geométrica',''),
    'along_track_bias_m':('Bias de progreso en el recorrido','m'),
    'along_track_mae_m':('MAE de progreso en el recorrido','m'),
    'along_track_n':('Pares de progreso no ambiguos',''),
    'ambiguous_projection_n':('Proyecciones ambiguas',''),
    'point_count':('Puntos GPS',''),
    'gps_gap_count':('Huecos GPS superiores a 5 s',''),
    'longest_gps_gap':('Mayor hueco GPS','s'),
    'median_sampling_seconds':('Intervalo mediano entre puntos','s'),
    'untimed_point_count':('Puntos sin tiempo',''),
    'segment_break_count':('Discontinuidades geométricas',''),
}


def archive_definitions(domain):
    if domain.startswith('GPS'):
        return [{'id':k,'name':name,'unit':unit} for k,(name,unit) in GPS_METRICS.items()]
    result=[]
    for key,(name,description,unit) in METRICS.items():
        if domain=='NIGHT_RMSSD' and key.startswith('within_'):continue
        result.append({'id':key,'name':name,'unit':'ms' if unit=='bpm' and domain=='NIGHT_RMSSD' else unit,'description':description})
    result.extend([{'id':k,'name':label,'unit':unit} for k,label,unit in [
        ('n','Pares de ventanas',''),('expected_pairs','Ventanas esperadas',''),('gap_seconds','Ausencia de pares','s'),('longest_gap_seconds','Mayor ausencia','s')]])
    return result
