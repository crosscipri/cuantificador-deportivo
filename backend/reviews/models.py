from html import escape
from html.parser import HTMLParser
from datetime import date
import re
from typing import Literal
from urllib.parse import urlparse, parse_qs
from pydantic import BaseModel, Field, ConfigDict, field_validator, model_validator


def safe_url(value: str) -> str:
    p = urlparse(value)
    return value if p.scheme in ('http', 'https') and p.hostname and not p.username and not p.password else ''


def validate_youtube(value: str) -> str:
    if not value:
        return ''
    if re.fullmatch(r'[\w-]{11}', value):
        return value
    p = urlparse(value)
    if p.scheme != 'https':
        raise ValueError('YouTube requiere HTTPS o un identificador de 11 caracteres')
    ident = p.path.strip('/') if p.hostname == 'youtu.be' else (parse_qs(p.query).get('v', [''])[0] if p.hostname in ('youtube.com', 'www.youtube.com', 'm.youtube.com') else '')
    if not re.fullmatch(r'[\w-]{11}', ident):
        raise ValueError('Vídeo de YouTube inválido')
    return ident


class Sanitizer(HTMLParser):
    allowed = {'p','br','strong','b','em','i','ul','ol','li','a','h2','h3','blockquote'}
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
    def handle_starttag(self, tag, attrs):
        if tag == 'div': tag = 'p'
        if tag in self.allowed:
            href = safe_url(dict(attrs).get('href', '')) if tag == 'a' else ''
            self.parts.append('<'+tag+(f' href="{escape(href, quote=True)}" rel="noopener noreferrer"' if href else '')+'>')
    def handle_endtag(self, tag):
        if tag == 'div': tag = 'p'
        if tag in self.allowed and tag != 'br':
            self.parts.append(f'</{tag}>')
    def handle_data(self, data):
        self.parts.append(escape(data))


def sanitize(value):
    parser = Sanitizer()
    parser.feed(value)
    return ''.join(parser.parts)


def visible_text(value):
    return re.sub(r'<[^>]*>', '', value).replace('&nbsp;', ' ').strip()


class Model(BaseModel):
    model_config = ConfigDict(extra='forbid', str_max_length=100000)


class MediaRef(Model):
    media_id: str = ''
    alt: str = ''
    caption: str = ''


class FCMember(Model):
    source_id: str
    revision: str = Field(pattern=r'^[a-f0-9]{64}$')


class EvidenceRef(Model):
    source_id: str = ''
    kind: Literal['fc','fc_total','gps','urban','night_rmssd','night_hr','comparison','sleep','archive'] = 'fc'
    revision: str = ''
    visualization: Literal['temporal','error','scatter','bland_altman','table','map','distribution'] = 'temporal'
    series: list[str] = Field(default_factory=lambda: ['device','reference'], max_length=100)
    start: float | None = None
    end: float | None = None
    members: list[FCMember] = Field(default_factory=list, max_length=100)
    sport: Literal['running','cycling','gym'] | None = None
    @model_validator(mode='after')
    def total_members(self):
        if self.kind == 'fc_total':
            if self.source_id != 'total' or not self.members:
                raise ValueError('La correlación por deporte requiere al menos una prueba FC vinculada')
            if len({m.source_id for m in self.members}) != len(self.members):
                raise ValueError('Una prueba no puede contarse dos veces en la correlación total')
            if self.visualization not in ('scatter','table') or self.start is not None or self.end is not None:
                raise ValueError('La correlación total admite dispersión o tabla, sin recorte temporal')
            if set(self.series) != {'device','reference'}:
                raise ValueError('La correlación total requiere dispositivo y referencia')
        elif self.members or self.sport is not None:
            raise ValueError('Solo la correlación por deporte admite una selección de pruebas y deporte')
        return self


class Alternative(Model):
    device_id: str = ''
    reason: str = ''


class ReviewScores(Model):
    # Existing correlation-based scores can be negative; never clamp them to zero.
    fc: float | None = Field(default=None, ge=-100, le=100, allow_inf_nan=False)
    hrv: float | None = Field(default=None, ge=-100, le=100, allow_inf_nan=False)
    rest_hr: float | None = Field(default=None, ge=-100, le=100, allow_inf_nan=False)
    gps: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    source: Literal['editorial','device'] = 'editorial'
    source_device_id: str = ''
    source_device_name: str = Field(default='', max_length=200)
    captured_at: str = Field(default='', max_length=50)


class Block(Model):
    id: str = Field(pattern=r'^[a-zA-Z0-9_-]{1,80}$')
    type: Literal['text','heading','image','gallery','video','chart','map','table','verdict','alternatives','purchase']
    text: str = ''
    level: Literal[2,3] = 2
    html: str = ''
    title: str = ''
    caption: str = ''
    explanation: str = ''
    media: list[MediaRef] = Field(default_factory=list, max_length=50)
    video: str = ''
    evidence: EvidenceRef | None = None
    table_origin: Literal['editorial','results'] = 'editorial'
    rows: list[list[str]] = Field(default_factory=list, max_length=100)
    recommended: str = ''
    not_recommended: str = ''
    pros: list[str] = Field(default_factory=list, max_length=100)
    cons: list[str] = Field(default_factory=list, max_length=100)
    scores: ReviewScores | None = None
    alternatives: list[Alternative] = Field(default_factory=list, max_length=30)
    link_ids: list[str] = Field(default_factory=list, max_length=30)
    affiliate_notice: str = ''
    _html = field_validator('html')(sanitize)


class Draft(Model):
    schema_version: Literal[1] = 1
    title: str = ''
    slug: str = Field(default='', max_length=120)
    summary: str = ''
    author: str = 'Cipri'
    cover: MediaRef = Field(default_factory=MediaRef)
    youtube: str = ''
    categories: list[str] = Field(default_factory=list, max_length=30)
    tags: list[str] = Field(default_factory=list, max_length=50)
    blocks: list[Block] = Field(default_factory=list, max_length=300)
    seo_title: str = ''
    seo_description: str = ''
    share_image: MediaRef = Field(default_factory=MediaRef)
    public_results: list[EvidenceRef] = Field(default_factory=list, max_length=100)
    @model_validator(mode='after')
    def block_ids(self):
        if len({b.id for b in self.blocks}) != len(self.blocks):
            raise ValueError('Identificadores de bloque duplicados')
        return self


class Save(Model):
    expected_revision: int = Field(ge=1)
    draft: Draft


class Revision(Model):
    expected_revision: int = Field(ge=1)


class Publication(Revision):
    preview_token: str | None = None


class MediaMetadata(Model):
    alt: str = ''
    caption: str = ''


class PurchaseLink(Model):
    id: str = Field(pattern=r'^[a-zA-Z0-9_-]{1,80}$')
    label: str
    url: str
    price: float | None = Field(default=None, ge=0, le=1000000, allow_inf_nan=False)
    currency: Literal['EUR','USD','GBP','CHF'] = 'EUR'
    price_checked_at: str = ''
    @field_validator('price_checked_at')
    @classmethod
    def valid_price_date(cls, value):
        if value:
            date.fromisoformat(value)
        return value
    @field_validator('url')
    @classmethod
    def valid_url(cls, value):
        if not safe_url(value):
            raise ValueError('El enlace debe ser HTTP(S)')
        return value


class Profile(Model):
    expected_revision: int = Field(ge=0)
    brand: str = ''
    model: str = ''
    format: str = ''
    characteristics: str = ''
    purchase_links: list[PurchaseLink] = Field(default_factory=list, max_length=30)
    @model_validator(mode='after')
    def unique_links(self):
        if len({x.id for x in self.purchase_links}) != len(self.purchase_links):
            raise ValueError('Enlaces duplicados')
        return self
