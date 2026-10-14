"""Descriptive comparisons of frozen editorial publications.

Only stored scalar metrics are summarized. No signal arrays, private device
profiles, live analyses, or new scientific ranking calculations are used here.
A mean is explicitly a mean of the available session metrics, never a pooled
estimate. Missing measurements remain missing.
"""
import math
import re
from collections import defaultdict

from .catalog import SCORE_KEYS, catalog_item, numeric

MAX_COMPARISON_ITEMS = 4
SPORT_LABELS = {'running': 'Running', 'cycling': 'Ciclismo', 'gym': 'Fuerza'}
DIMENSION_LABELS = {'fc': 'Frecuencia cardíaca', 'hrv': 'HRV',
                    'rest_hr': 'FC en reposo', 'gps': 'GPS'}
EVIDENCE_FIELDS = (
    'id', 'kind', 'source_id', 'name', 'sport', 'date', 'reference',
    'analysis_version', 'revision', 'session_count', 'night_count',
    'summary_metrics', 'unit', 'limitations', 'members',
)


def parse_comparison_slugs(values):
    """Validate a bounded list and preserve user selection order."""
    if len(values) > 16:
        raise ValueError('Selecciona un máximo de cuatro reviews')
    slugs = list(dict.fromkeys(value.strip() for value in values))
    if len(slugs) > MAX_COMPARISON_ITEMS:
        raise ValueError('Selecciona un máximo de cuatro reviews')
    if any(len(slug) > 120 or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug) for slug in slugs):
        raise ValueError('Identificador de review inválido')
    return slugs


def comparison_projection():
    """Mongo projection excludes large signals before transferring any document."""
    fields = ('version', 'published_at', 'first_published_at', 'device', 'media',
              'article.slug', 'article.title', 'article.summary', 'article.author',
              'article.cover', 'article.categories', 'article.tags')
    projection = {f'active.{key}': 1 for key in fields}
    projection['_id'] = 0
    projection['active.article.blocks'] = {'$filter': {
        'input': {'$ifNull': ['$active.article.blocks', []]}, 'as': 'block',
        'cond': {'$in': ['$$block.type', ['verdict', 'purchase']]}}}
    projection['active.evidence'] = {'$arrayToObject': {'$map': {
        'input': {'$objectToArray': {'$ifNull': ['$active.evidence', {}]}},
        'as': 'entry', 'in': {'k': '$$entry.k', 'v': {
            key: '$$entry.v.' + key for key in EVIDENCE_FIELDS}}}}}
    return projection


def _metric(evidence, key, unit):
    for row in evidence.get('summary_metrics') or []:
        if row.get('key') == key and numeric(row.get('value')) and row.get('unit', '') == unit:
            return row['value']
    return None


def _source(ident, evidence, definitions):
    metrics = []
    for key, original, label, unit in definitions:
        value = _metric(evidence, original, unit)
        if value is not None:
            metrics.append({'key': key, 'label': label, 'value': value, 'unit': unit})
    # Explicit projection, including no arbitrary configuration or source fields.
    return {'id': ident, 'source_id': evidence.get('source_id'),
            'name': evidence.get('name') or 'Prueba publicada', 'date': evidence.get('date'),
            'reference': evidence.get('reference'), 'revision': evidence.get('revision'),
            'analysis_version': evidence.get('analysis_version'), 'metrics': metrics}


def _group(key, label, entries, definitions, noun='prueba'):
    sources = [_source(ident, evidence, definitions) for ident, evidence in entries]
    metrics = []
    for metric_key, _, metric_label, unit in definitions:
        values = [row['value'] for source in sources for row in source['metrics'] if row['key'] == metric_key]
        if not values:
            continue
        summing = metric_key == 'n'
        # Retain full precision; display rounding belongs to the UI.
        value = math.fsum(values) if summing else math.fsum(values) / len(values)
        if not math.isfinite(value):
            continue
        metrics.append({'key': metric_key,
                        'label': 'Pares de las pruebas' if summing else metric_label + ' · media por ' + noun,
                        'value': value, 'unit': unit, 'aggregation': 'sum' if summing else 'session_mean',
                        'count': len(values)})
    return {'key': key, 'label': label, 'sessions': len(sources), 'metrics': metrics,
            'references': sorted({source['reference'] for source in sources if source['reference']}),
            'sources': sources}


FC_METRICS = (('mae', 'mae', 'Error absoluto (MAE)', 'bpm'),
              ('ccc', 'ccc', 'Acuerdo (CCC)', ''),
              ('bias', 'bias', 'Sesgo', 'bpm'),
              ('n', 'n', 'Pares válidos', 'pares'))
NIGHT_HRV_METRICS = (('mae', 'rmssdMAE', 'Error absoluto (MAE)', 'ms'),
                     ('bias', 'biasMean', 'Sesgo', 'ms'),
                     ('r', 'pearsonR', 'Correlación (r)', ''))
NIGHT_HR_METRICS = (('mae', 'hrMAE', 'Error absoluto (MAE)', 'bpm'),
                    ('r', 'pearsonRHR', 'Correlación (r)', ''))
GPS_METRICS = (('distance_error_m', 'distance_error_m', 'Diferencia de distancia', 'm'),
               ('cross_track_mean_m', 'cross_track_mean_m', 'Separación respecto a la referencia', 'm'),
               ('cross_track_p95_m', 'cross_track_p95_m', 'Separación (P95)', 'm'))


def comparison_item(payload):
    item = catalog_item(payload)
    verdict = next((block for block in payload['article'].get('blocks', []) if block.get('type') == 'verdict'), {})
    sports, nights, gps, pooled = defaultdict(list), defaultdict(list), defaultdict(list), defaultdict(list)
    seen = {}
    conflicts = False
    evidence_limitations = set()
    for ident, evidence in (payload.get('evidence') or {}).items():
        kind = evidence.get('kind')
        if kind not in ('fc', 'fc_total', 'night_hr', 'night_rmssd', 'gps', 'urban'):
            continue
        sport = evidence.get('sport') or 'other'
        if kind == 'fc_total':
            pooled[sport].append((ident, evidence))
            continue
        # The same original test can have chart, table and public-result exports.
        # Count it once, even if visualization IDs differ. A conflicting frozen
        # revision is never a second independent experiment.
        unique = (kind, evidence.get('source_id') or ident)
        if unique in seen:
            conflicts |= seen[unique] != evidence.get('revision')
            continue
        seen[unique] = evidence.get('revision')
        if evidence.get('limitations'):
            evidence_limitations.add(evidence['limitations'])
        group = sports[sport] if kind == 'fc' else nights[kind] if kind.startswith('night_') else gps[kind]
        group.append((ident, evidence))
    sport_groups = []
    for key in sorted(sports, key=lambda value: (list(SPORT_LABELS).index(value) if value in SPORT_LABELS else 99, value)):
        group = _group(key, SPORT_LABELS.get(key, key if key != 'other' else 'Otro deporte'), sports[key], FC_METRICS)
        selected = {(e.get('source_id'), e.get('revision')) for _, e in sports[key]}
        for ident, total in pooled.get(key, []):
            members = {(entry.get('source_id'), entry.get('revision')) for entry in total.get('members') or []}
            # Only display pooled r when it describes exactly these frozen tests.
            if not selected or members != selected:
                continue
            correlation = _metric(total, 'r', '')
            if correlation is not None:
                group['metrics'].append({'key': 'r', 'label': 'Correlación conjunta publicada (r)',
                    'value': correlation, 'unit': '', 'aggregation': 'frozen_pooled', 'count': len(selected)})
                group['pooled_source'] = _source(ident, total, (('r', 'r', 'Correlación conjunta (r)', ''),
                                                            ('n', 'n', 'Pares guardados', 'pares guardados')))
                if total.get('limitations'):
                    evidence_limitations.add(total['limitations'])
                break
        sport_groups.append(group)
    night_groups = []
    for kind, key, label, definitions in (
        ('night_rmssd', 'hrv', 'HRV nocturna (RMSSD)', NIGHT_HRV_METRICS),
        ('night_hr', 'rest_hr', 'FC nocturna', NIGHT_HR_METRICS),
    ):
        if nights[kind]:
            night_groups.append(_group(key, label, nights[kind], definitions, 'noche'))
    gps_groups = [_group(key, label, gps[kind], GPS_METRICS)
                  for kind, key, label in (('gps', 'track', 'GPS en pista'), ('urban', 'urban', 'GPS en ciudad')) if gps[kind]]
    limitations = [
        'Comparación descriptiva de las pruebas incluidas en cada review. Los dispositivos pueden tener protocolos, intensidades y cantidades de pruebas diferentes.',
        'Las medias por prueba o noche dan el mismo peso a cada métrica original disponible; no son métricas calculadas con todas las muestras juntas.',
        'Una puntuación ausente no equivale a cero. La nota total es la media de las áreas evaluadas y puede tener distinta cobertura entre dispositivos.',
        'La selección editorial no certifica la comparabilidad científica ni la elegibilidad para un ranking.',
    ]
    if night_groups:
        limitations.append('La FC nocturna se muestra con su nombre original: no acredita una medición específica de FC en reposo.')
    if any(not group['metrics'] for group in gps_groups):
        limitations.append('Las pruebas GPS sin métricas escalares publicadas aportan recorridos y cobertura; no se deduce su error a partir de las coordenadas del mapa.')
    if conflicts:
        limitations.append('Hay varias revisiones publicadas de una misma prueba. Se usa la primera aparición y se cuenta una sola vez.')
    item['comparison'] = {
        'dimensions': [{'key': key, 'label': DIMENSION_LABELS[key], 'value': item['rating'][key], 'unit': 'sobre 100'} for key in SCORE_KEYS],
        'sports': sport_groups, 'nights': night_groups, 'gps': gps_groups,
        'verdict': verdict.get('text') or '', 'pros': list(verdict.get('pros') or []),
        'cons': list(verdict.get('cons') or []), 'recommended': verdict.get('recommended') or '',
        'not_recommended': verdict.get('not_recommended') or '',
        'coverage': {'fc_sessions': sum(g['sessions'] for g in sport_groups),
                     'hrv_nights': len(nights['night_rmssd']), 'hr_nights': len(nights['night_hr']),
                     'gps_tests': sum(g['sessions'] for g in gps_groups),
                     'sports': len(sport_groups), 'areas': item['rating']['areas']},
        'limitations': limitations, 'evidence_limitations': sorted(evidence_limitations),
    }
    return item


def comparison_page(slugs, payloads):
    indexed = {payload['article']['slug']: payload for payload in payloads}
    return {'items': [comparison_item(indexed[slug]) for slug in slugs if slug in indexed],
            'missing': [slug for slug in slugs if slug not in indexed], 'limit': MAX_COMPARISON_ITEMS}
