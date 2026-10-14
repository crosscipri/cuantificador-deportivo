"""Compact chart data from every active, frozen editorial publication.

The catalog owns the editorial score, and comparison owns the descriptive
aggregates. This projection only removes per-test provenance; it never turns a
correlation, an absent metric, or a GPS route into a new score.
"""
from .catalog import folded
from .comparison import comparison_item


def rankings_item(payload):
    item = comparison_item(payload)
    comparison = item['comparison']
    item['comparison'] = {
        'coverage': comparison['coverage'],
        **{kind: [{key: group[key] for key in ('key', 'label', 'sessions', 'metrics')}
                  for group in comparison[kind]]
           for kind in ('sports', 'nights', 'gps')},
        'limitations': comparison['limitations'],
        'evidence_limitations': comparison['evidence_limitations'],
    }
    return item


def rankings_page(payloads):
    items = sorted((rankings_item(payload) for payload in payloads),
                   key=lambda item: (folded(item['device'].get('name')), item['article']['slug']))
    return {'items': items, 'total': len(items)}
