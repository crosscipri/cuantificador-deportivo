#!/usr/bin/env python3
"""Renderiza el artículo a HTML estático para revisarlo en el navegador.

No sustituye la plantilla de producción: reutiliza el JSON, las tablas y los
SVG, y el mismo aviso de afiliación. La salida queda en /tmp/mascarillas-led-preview.
"""

from __future__ import annotations

import html
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTICLE = ROOT / "content" / "articles" / "mejores-mascarillas-led-faciales-amazon-2026.json"
OUT = Path("/tmp/mascarillas-led-preview")


def render_block(block: dict) -> str:
    kind = block["type"]
    if kind == "heading":
        level = 2 if block.get("level") == 2 else 3
        return f"<h{level} id=\"{html.escape(block['id'])}\">{html.escape(block['text'])}</h{level}>"
    if kind == "text":
        return block["html"]
    if kind == "table":
        rows = block["rows"]
        head = "".join(f"<th scope=\"col\">{html.escape(cell)}</th>" for cell in rows[0])
        body = []
        for row in rows[1:]:
            cells = "".join(f"<td>{html.escape(cell)}</td>" for cell in row)
            body.append(f"<tr>{cells}</tr>")
        return (
            f"<h3>{html.escape(block['title'])}</h3>"
            "<div class=\"table-wrap\"><table><thead><tr>"
            f"{head}</tr></thead><tbody>{''.join(body)}</tbody></table></div>"
        )
    if kind == "purchase":
        links = []
        for link in block["links"]:
            price = link.get("price")
            price_text = ""
            if price is not None:
                price_text = f"<strong>{price:.2f} €".replace(".", ",") + "</strong>"
            checked = link.get("price_checked_at") or ""
            links.append(
                "<a class=\"shop-link\" target=\"_blank\" rel=\"sponsored nofollow noopener noreferrer\" "
                f"href=\"{html.escape(link['url'])}\"><span>{html.escape(link['label'])}</span>{price_text}"
                f"<small>Consultado {html.escape(checked)}</small></a>"
            )
        return (
            f"<h3>{html.escape(block.get('title') or 'Dónde comprar')}</h3>"
            f"<p class=\"affiliate-note\">{html.escape(block['affiliate_notice'])}</p>"
            f"<div class=\"shops\">{''.join(links)}</div>"
        )
    return ""


def json_ld(payload: dict) -> str:
    article = payload["article"]
    url = "https://elcuantificador.com" + payload["public_path"]
    graph = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "Article",
                "@id": url + "#article",
                "headline": article["seo_title"],
                "description": article["seo_description"],
                "image": ["https://elcuantificador.com" + article["cover"]["path"]],
                "datePublished": payload["published_at"],
                "dateModified": payload["updated_at"],
                "inLanguage": "es",
                "mainEntityOfPage": url,
                "author": {
                    "@type": "Person",
                    "@id": "https://elcuantificador.com/autor/cipri/#person",
                    "name": "Cipri",
                    "url": "https://elcuantificador.com/autor/cipri/",
                },
                "publisher": {"@id": "https://elcuantificador.com/#organization"},
            },
            {
                "@type": "FAQPage",
                "@id": url + "#faq",
                "mainEntity": [
                    {
                        "@type": "Question",
                        "name": item["name"],
                        "acceptedAnswer": {"@type": "Answer", "text": item["text"]},
                    }
                    for item in payload["faq"]
                ],
            },
        ],
    }
    return json.dumps(graph, ensure_ascii=False)


def main() -> None:
    payload = json.loads(ARTICLE.read_text(encoding="utf-8"))
    article = payload["article"]
    if OUT.exists():
        shutil.rmtree(OUT)
    images = OUT / "images" / "articulos" / "mascarillas-led-2026"
    images.mkdir(parents=True)
    src_dir = ROOT / "content" / "images" / "articulos" / "mascarillas-led-2026"
    for svg in src_dir.glob("*.svg"):
        shutil.copy(svg, images / svg.name)
    body = "\n".join(render_block(block) for block in article["blocks"])
    cover = article["cover"]["path"]
    document = f"""<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(article['seo_title'])}</title>
  <meta name="description" content="{html.escape(article['seo_description'])}">
  <link rel="canonical" href="https://elcuantificador.com{payload['public_path']}">
  <meta property="og:title" content="{html.escape(article['seo_title'])}">
  <meta property="og:description" content="{html.escape(article['seo_description'])}">
  <meta property="og:type" content="article">
  <meta property="og:locale" content="es_ES">
  <meta property="og:url" content="https://elcuantificador.com{payload['public_path']}">
  <meta property="og:image" content="https://elcuantificador.com{cover}">
  <script type="application/ld+json">{json_ld(payload)}</script>
  <style>
    :root {{ --ink:#161616; --ink-3:#505050; --accent:#0055ff; --line:#e3e3e3; --paper:#fff; --soft:#edf3ff; }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; color:var(--ink); background:var(--paper); font:18px/1.7 Arial, Helvetica, sans-serif; }}
    a {{ color:var(--accent); }}
    header.site {{ border-bottom:1px solid var(--line); }}
    .bar {{ max-width:1120px; margin:0 auto; padding:20px 24px; display:flex; justify-content:space-between; gap:16px; align-items:center; }}
    .brand {{ font-weight:700; letter-spacing:.04em; color:var(--ink); text-decoration:none; font-size:14px; }}
    nav a {{ color:var(--ink); text-decoration:none; margin-left:18px; font-size:14px; }}
    main {{ max-width:880px; margin:0 auto; padding:28px 24px 80px; }}
    .crumbs {{ font-size:13px; color:var(--ink-3); }}
    .crumbs a {{ color:var(--ink-3); text-decoration:none; }}
    .eyebrow {{ color:var(--accent); letter-spacing:.08em; font-size:12px; text-transform:uppercase; margin:28px 0 0; }}
    h1 {{ font-size:clamp(34px, 6vw, 56px); line-height:1.05; letter-spacing:-.04em; font-weight:650; margin:12px 0; }}
    h2 {{ font-size:clamp(28px, 4vw, 40px); line-height:1.1; letter-spacing:-.03em; font-weight:650; margin:48px 0 12px; }}
    h3 {{ font-size:22px; margin:28px 0 8px; }}
    .byline {{ color:var(--ink-3); font-size:14px; }}
    .summary {{ font-size:20px; }}
    .cover {{ width:100%; height:auto; background:#f7f7f7; }}
    figure {{ margin:24px 0; }}
    figcaption, .note {{ color:var(--ink-3); font-size:14px; }}
    img {{ max-width:100%; height:auto; }}
    .table-wrap {{ overflow-x:auto; border:1px solid var(--line); }}
    table {{ border-collapse:collapse; width:100%; font-size:14px; }}
    th, td {{ text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; }}
    th {{ background:#f7f7f7; }}
    .affiliate-note {{ background:var(--soft); padding:14px 16px; font-size:15px; }}
    .shops {{ display:grid; gap:10px; }}
    .shop-link {{ display:flex; justify-content:space-between; gap:12px; align-items:baseline; border:1px solid var(--line); padding:12px 14px; text-decoration:none; color:var(--ink); }}
    .shop-link strong {{ color:var(--ink); }}
    .shop-link small {{ color:var(--ink-3); }}
    @media (max-width:700px) {{
      nav {{ display:none; }}
      .shop-link {{ flex-direction:column; gap:2px; }}
      h1 {{ font-size:34px; }}
    }}
  </style>
</head>
<body>
  <header class="site"><div class="bar"><a class="brand" href="/">EL CUANTIFICADOR</a>
    <nav><a href="/reviews/">Reviews</a><a href="/articulos/">Artículos</a><a href="/comparar/">Comparar</a><a href="/guias/">Guías</a></nav>
  </div></header>
  <main>
    <p class="crumbs"><a href="/">Inicio</a> / <a href="/articulos/">Artículos</a> / <span>{html.escape(article['title'])}</span></p>
    <p class="eyebrow">Guía</p>
    <h1>{html.escape(article['title'])}</h1>
    <p class="byline"><a href="/autor/cipri/">El Cuantificador</a> · Publicado el <time datetime="{payload['published_at']}">25/11/2026</time> · Actualizado el <time datetime="{payload['updated_at']}">25/11/2026</time></p>
    <p class="summary">{html.escape(article['summary'])}</p>
    <img class="cover" src="{html.escape(cover)}" alt="{html.escape(article['cover']['alt'])}" width="1200" height="750">
    {body}
  </main>
</body>
</html>
"""
    (OUT / "index.html").write_text(document, encoding="utf-8")
    print(OUT / "index.html")


if __name__ == "__main__":
    main()
