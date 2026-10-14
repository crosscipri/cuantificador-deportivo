interface Metric {
  key: string;
  value: number | null;
  unit: string;
}
interface Definition {
  keys: string[];
  label: string;
  description: string;
  decimals?: number;
  signed?: boolean;
}
const ERROR: Definition = {keys:['mae','rmssdMAE','hrMAE'],label:'Error medio · MAE',description:'Separación media respecto a la referencia, sin compensar errores.'};
const AGREEMENT: Definition = {keys:['ccc','r','pearsonR','pearsonRHR'],label:'Acuerdo · CCC',description:'Cuanto más cerca de 1, mayor coincidencia entre las lecturas.',decimals:3};
const CORRELATION: Definition = {keys:['r','pearsonR','pearsonRHR'],label:'Correlación · r',description:'Cómo varían juntas las señales; no implica que midan lo mismo.',decimals:3};
const BIAS: Definition = {keys:['bias','biasMean'],label:'Sesgo medio',description:'Positivo: mide por encima de la referencia. Negativo: por debajo.',signed:true};
const SLEEP: Definition[] = [
  {keys:['agreement_percent'],label:'Coincidencia de fases',description:'Porcentaje de intervalos con la misma fase de sueño.'},
  {keys:['kappa'],label:'Acuerdo · Kappa',description:'Coincidencia de fases teniendo en cuenta la esperada por azar.',decimals:3},
  {keys:['coverage_percent'],label:'Cobertura',description:'Porcentaje de intervalos con datos válidos.'},
];
const GPS: Definition[] = [
  {keys:['distance_error_m'],label:'Diferencia de distancia',description:'Distancia calculada de la traza menos la distancia de referencia.',signed:true},
  {keys:['cross_track_mean_m'],label:'Separación media',description:'Distancia media de los puntos a la línea de referencia.'},
  {keys:['cross_track_p95_m'],label:'Separación · P95',description:'El 95 % de los puntos queda a esta distancia o menos de la referencia.'},
];
export function evidenceMetricRows(evidence:any):Metric[] {
  return evidence?.summary_metrics ?? evidence?.metrics ?? [];
}
const valid = (m:Metric):boolean => typeof m.value==='number' && Number.isFinite(m.value);

/** A reading summary only: never recompute, round, or remove stored metrics. */
export function keyReviewMetrics(evidence:any) {
  const rows=evidenceMetricRows(evidence);
  const definitions=evidence?.kind==='sleep' ? SLEEP
    : rows.some(m=>GPS.some(d=>d.keys.includes(m.key))) ? GPS
    : [ERROR,AGREEMENT,BIAS];
  return definitions.flatMap(definition=>{
    const metric=definition.keys.map(key=>rows.find(m=>m.key===key && valid(m))).find(Boolean);
    if(!metric)return [];
    // Pearson is a fallback when concordance is absent, never relabel it as CCC.
    const display=definition===AGREEMENT && metric.key!=='ccc' ? CORRELATION : definition;
    const value=metric.value as number;
    return [{key:metric.key,label:display.label,description:display.description,
      value:(display.signed && value>0 ? '+' : '')+value.toLocaleString('es-ES',{maximumFractionDigits:display.decimals ?? 2}),
      unit:metric.unit==='bpm' ? 'lpm' : metric.unit}];
  });
}

export function metricSampleContext(evidence:any):string {
  const rows=evidenceMetricRows(evidence);
  const metric=['n','n_samples','n_epochs','point_count'].map(key=>rows.find(m=>m.key===key && valid(m))).find(Boolean);
  if(!metric)return '';
  const unit=metric.key==='n_epochs' ? 'intervalos válidos' : metric.key==='point_count' ? 'puntos GPS' : 'pares válidos';
  return metric.value!.toLocaleString('es-ES',{maximumFractionDigits:0})+' '+unit;
}
