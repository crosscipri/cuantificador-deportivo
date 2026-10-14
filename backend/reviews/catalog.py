"""Small catalog projections from immutable publication snapshots.

Shared by the public API and the local draft viewer. Filtering and ordering
happen before pagination; no analysis arrays or current private profiles leak.
"""
import math
import re
import unicodedata
from collections import Counter
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator

SCORE_KEYS = ('fc', 'hrv', 'rest_hr', 'gps')
AMAZON_DOMAINS = ('amazon.es', 'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr',
                  'amazon.it', 'amazon.nl', 'amazon.com.be', 'amazon.se', 'amazon.pl',
                  'amazon.ie', 'amazon.ca', 'amazon.com.mx', 'amazon.com.au', 'amazon.co.jp',
                  'amzn.to', 'amzn.eu')


def folded(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', str(value or '')).casefold()
                   if not unicodedata.combining(c))


def numeric(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


class CatalogFilters(BaseModel):
    page: int = Field(default=1, ge=1)
    limit: int = Field(default=12, ge=1, le=50)
    q: str = Field(default='', max_length=100)
    brand: list[str] = Field(default_factory=list, max_length=30)
    category: list[str] = Field(default_factory=list, max_length=30)
    format: list[str] = Field(default_factory=list, max_length=30)
    shop: list[str] = Field(default_factory=list, max_length=30)
    metric: Literal['total', 'fc', 'hrv', 'rest_hr', 'gps'] = 'total'
    min_score: float | None = Field(default=None, ge=-100, le=100, allow_inf_nan=False)
    max_price: float | None = Field(default=None, ge=0, le=1000000, allow_inf_nan=False)
    complete_only: bool = False
    amazon_only: bool = False
    offers_only: bool = False
    sort: Literal['latest', 'score_desc', 'score_asc', 'price_asc', 'price_desc', 'name'] = 'latest'

    @field_validator('q')
    @classmethod
    def trim_search(cls, value):
        return value.strip()

    @field_validator('brand', 'category', 'format', 'shop')
    @classmethod
    def clean_choices(cls, values):
        if any(len(v) > 100 for v in values):
            raise ValueError('Filtro demasiado largo')
        return list(dict.fromkeys(v.strip() for v in values if v.strip()))


def parse_catalog_filters(pairs):
    values = {}
    for key, value in pairs:
        if key in ('brand', 'category', 'format', 'shop'):
            values.setdefault(key, []).append(value)
        else:
            values[key] = value
    return CatalogFilters(**values)


def purchase_offers(payload):
    notices = {link['id']: block.get('affiliate_notice', '')
               for block in payload['article'].get('blocks', []) if block.get('type') == 'purchase'
               for link in block.get('links', [])}
    offers = []
    for link in payload.get('device', {}).get('purchase_links', []):
        # A saved device link alone does not authorize displaying a purchase
        # offer. It must also belong to a selected frozen editorial block.
        if link.get('id') not in notices:
            continue
        url = link.get('url', '')
        if not isinstance(url, str) or re.search(r'[\x00-\x20\x7f\\]', url):
            continue
        try:
            parsed = urlsplit(url)
            host = (parsed.hostname or '').lower()
            parsed.port  # Reject invalid/out-of-range ports instead of emitting broken URLs.
        except ValueError:
            continue
        if parsed.scheme not in ('http', 'https') or parsed.username or parsed.password:
            continue
        if not host:
            continue
        is_amazon = any(host == domain or host.endswith('.' + domain) for domain in AMAZON_DOMAINS)
        shop = 'amazon' if is_amazon else host.removeprefix('www.')
        price = link.get('price')
        offers.append({'url': link['url'], 'label': 'Amazon' if is_amazon else link.get('label') or shop,
                       'shop': shop, 'is_amazon': is_amazon,
                       'price': price if numeric(price) and price >= 0 else None,
                       'currency': link.get('currency') or 'EUR',
                       'price_checked_at': link.get('price_checked_at', ''),
                       'notice': notices.get(link.get('id'), '')})
    # Favor EUR without comparing amounts in different currencies.
    return sorted(offers, key=lambda x: (x['currency'] != 'EUR', x['currency'],
                  x['price'] is None, x['price'] or 0, not x['is_amazon'], x['url']))


def amazon_offer(payload):
    return next((offer for offer in purchase_offers(payload) if offer['is_amazon']), None)


def catalog_item(payload):
    article = payload['article']
    verdict = next((b for b in article.get('blocks', []) if b.get('type') == 'verdict'), {})
    scores = verdict.get('scores') or {}
    dimensions = {key: scores.get(key) if numeric(scores.get(key)) else None for key in SCORE_KEYS}
    available = [value for value in dimensions.values() if value is not None]
    rating = {**dimensions, 'areas': len(available),
              'total': math.floor(sum(available) / len(available) * 10 + .5) / 10 if available else None}
    cover_id = (article.get('cover') or {}).get('media_id', '')
    offers = purchase_offers(payload)
    return {'version': payload['version'], 'published_at': payload.get('published_at'),
            'first_published_at': payload.get('first_published_at'),
            'updated_at': payload.get('published_at') or (payload.get('preview') or {}).get('saved_at'),
            'article': {key: article.get(key) for key in ('slug', 'title', 'summary', 'author', 'cover', 'categories', 'tags')},
            'device': {key: payload.get('device', {}).get(key) for key in ('name', 'brand', 'model', 'format')},
            'media': {cover_id: payload.get('media', {}).get(cover_id)},
            'rating': rating, 'amazon': next((o for o in offers if o['is_amazon']), None),
            'offers': offers, 'best_offer': offers[0] if offers else None}


def catalog_page(items, filters):
    def choices(values):
        return [{'value': value, 'count': count} for value, count in sorted(Counter(values).items(), key=lambda x: folded(x[0])) if value]
    facets = {'brands': choices(p['device'].get('brand') for p in items),
              'categories': choices(c for p in items for c in set(p['article'].get('categories') or [])),
              'formats': choices(p['device'].get('format') for p in items),
              'shops': choices(s for p in items for s in {o['shop'] for o in p.get('offers', [])}),
              'amazon_count': sum(p['amazon'] is not None for p in items),
              'offers_count': sum(bool(p.get('offers')) for p in items)}
    brands = {folded(x) for x in filters.brand}
    categories = {folded(x) for x in filters.category}
    formats = {folded(x) for x in filters.format}
    shops = {value.casefold() for value in filters.shop}
    words = folded(filters.q).split()
    def matching_offers(item):
        offers = item.get('offers', [item['amazon']] if item['amazon'] else [])
        return [o for o in offers if (not shops or o.get('shop', 'amazon') in shops)
                and (not filters.amazon_only or o.get('is_amazon', o is item['amazon']))]
    def eur_price(item):
        prices = [o['price'] for o in matching_offers(item) if o['currency'] == 'EUR' and o['price'] is not None]
        return min(prices) if prices else None
    def matches(item):
        device, article, rating = item['device'], item['article'], item['rating']
        text = folded(' '.join(str(x or '') for x in [device.get('name'), device.get('brand'), device.get('model'), article['title'], *(article.get('tags') or [])]))
        score = rating[filters.metric]
        price = eur_price(item)
        return (all(word in text for word in words)
                and (not brands or folded(device.get('brand')) in brands)
                and (not categories or categories.intersection(folded(c) for c in article.get('categories') or []))
                and (not formats or folded(device.get('format')) in formats)
                and (not shops or bool(matching_offers(item)))
                and (filters.min_score is None or score is not None and score >= filters.min_score)
                and (not filters.complete_only or rating['areas'] == 4)
                and (not filters.amazon_only or bool(matching_offers(item)))
                and (not filters.offers_only or item.get('offers'))
                and (filters.max_price is None or price is not None and price <= filters.max_price))
    result = sorted((p for p in items if matches(p)), key=lambda p: (folded(p['device'].get('name')), p['article']['slug']))
    if filters.sort == 'latest':
        result.sort(key=lambda p: p['updated_at'] or '', reverse=True)
    elif filters.sort.startswith(('score_', 'price_')):
        descending = filters.sort.endswith('_desc')
        def key(item):
            value = item['rating'][filters.metric] if filters.sort.startswith('score_') else eur_price(item)
            return (value is None, (-value if descending else value) if value is not None else 0)
        result.sort(key=key)
    total = len(result)
    start = (filters.page - 1) * filters.limit
    page_items = [{**item, 'matched_offer': next(iter(matching_offers(item)), None)}
                  for item in result[start:start + filters.limit]]
    return {'items': page_items, 'total': total, 'total_unfiltered': len(items),
            'page': filters.page, 'limit': filters.limit, 'has_more': start + filters.limit < total,
            'facets': facets, 'filters': filters.model_dump(exclude={'page', 'limit'})}
