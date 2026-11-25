#!/usr/bin/env python3
"""Comprueba el artículo generado: cifras, afiliados, orden y gráficas."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from build_mascarillas_led_article import (  # noqa: E402
    ARTICLE_PATH,
    IMG_DIR,
    MASKS,
    SEO_DESCRIPTION,
    SLUG,
    TAG,
    amazon,
    es_num,
    index_of,
)

FORBIDDEN = (
    "cura las arrugas",
    "elimina las arrugas",
    "quita las arrugas",
    "rejuvenece",
    "resultado garantizado",
    "clínicamente probado",
)


def fail(message: str) -> None:
    raise SystemExit(message)


def main() -> None:
    payload = json.loads(ARTICLE_PATH.read_text(encoding="utf-8"))
    article = payload["article"]
    if article["slug"] != SLUG or payload["public_path"] != f"/articulos/{SLUG}/":
        fail("slug o ruta pública inesperados")
    if article["seo_description"] != SEO_DESCRIPTION:
        fail("la meta description no coincide con la fuente")
    if not 140 <= len(article["seo_description"]) <= 155:
        fail(f"seo_description debe quedar entre 140 y 155 caracteres, tiene {len(article['seo_description'])}")
    if payload["article_kind"] != "guide" or article["author"] != "Cipri":
        fail("tipo o autor inesperados")
    if "25/11/2026" not in json.dumps(payload, ensure_ascii=False):
        fail("falta la nota de precio consultado el 25/11/2026")

    text = json.dumps(payload, ensure_ascii=False)
    lowered = text.lower()
    for phrase in FORBIDDEN:
        if phrase in lowered:
            fail(f"promesa médica no permitida: {phrase}")

    ordered = sorted(MASKS, key=lambda mask: -index_of(mask))
    if [mask["id"] for mask in ordered] != ["nanoleaf", "inia", "lumalux", "currentbody", "omnilux", "foreo"]:
        fail(f"orden inesperado: {[mask['id'] for mask in ordered]}")
    if not ordered[0]["recommended"] or not ordered[-1]["avoid"]:
        fail("la Nanoleaf debe ir recomendada y la Foreo como no recomendada")

    urls = {amazon(mask["asin"]) for mask in MASKS}
    for url in urls:
        if url not in text or f"tag={TAG}" not in url:
            fail(f"falta el enlace de afiliado {url}")
    if text.count(f"tag={TAG}") < len(MASKS):
        fail("faltan etiquetas de afiliado")
    if text.count("sponsored nofollow noopener noreferrer") < len(MASKS):
        fail("faltan rel sponsored nofollow en los enlaces del cuerpo")

    for mask in MASKS:
        if mask["review"] not in text:
            fail(f"falta la review de {mask['short']}")
        if mask["dose"] is None and "sin dato" not in text.lower():
            fail("la Foreo debe constar sin dosis, no como cero")
    if "LumaLux Face V2" not in text or "MitoGlow" not in text:
        fail("faltan los modelos mejor puntuados que no están en Amazon España")
    if "no es la V2" not in text and "no es la LumaLux Face V2" not in text and "No es la LumaLux Face V2" not in text:
        fail("hay que distinguir la Face Pro de la V2")

    purchase = next(block for block in article["blocks"] if block["type"] == "purchase")
    if purchase["links"][0]["url"] != amazon("B0DQSK8Y52"):
        fail("el primer enlace de compra debe ser la Nanoleaf")
    if "elcuantificad-21" not in purchase["affiliate_notice"]:
        fail("el aviso de afiliación no cita la etiqueta")
    if len(purchase["links"]) != 6:
        fail("el bloque de compra debe listar las seis fichas")

    for name in ("nota-precio.svg", "dosis.svg", "espectro.svg", "esquema-pbm.svg", "portada.svg"):
        svg = (IMG_DIR / name).read_text(encoding="utf-8")
        if "<svg" not in svg or "Sin dato" not in svg and name == "dosis.svg":
            fail(f"gráfica incompleta: {name}")
        if name == "espectro.svg" and "630" not in svg:
            fail("el espectro no marca la ventana roja")
        if name == "nota-precio.svg" and "77,5" not in svg:
            fail("la dispersión no muestra la nota 77,5")
    if es_num(round(index_of(ordered[0]) + 1e-9, 2), 2) not in text:
        fail("el índice de la Nanoleaf no está en el artículo")
    print("ok", SLUG, "indice", es_num(round(index_of(ordered[0]) + 1e-9, 2), 2))


if __name__ == "__main__":
    main()
