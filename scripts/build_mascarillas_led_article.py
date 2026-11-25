#!/usr/bin/env python3
"""Genera el artículo, las gráficas SVG y la ficha del índice.

Fuente única de los números. La salida commiteada es el JSON que ya publica
elcuantificador.com en /api/public/articles/<slug>/index.json y los SVG que
el HTML enlaza en /images/articulos/mascarillas-led-2026/.
"""

from __future__ import annotations

import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SLUG = "mejores-mascarillas-led-faciales-amazon-2026"
PUBLIC_PATH = f"/articulos/{SLUG}/"
IMG = f"/images/articulos/mascarillas-led-2026"
IMG_DIR = ROOT / "content" / "images" / "articulos" / "mascarillas-led-2026"
ARTICLE_PATH = ROOT / "content" / "articles" / f"{SLUG}.json"
INDEX_PATH = ROOT / "content" / "articles" / "index.json"
TAG = "elcuantificad-21"
CHECKED = "25/11/2026"
CHECKED_ISO = "2026-11-25"

# Precios y óptica tal como se consultaron. No añadir modelos ni cifras.
MASKS = [
    {
        "id": "nanoleaf",
        "name": "Nanoleaf LED Facial Therapy Mask",
        "short": "Nanoleaf",
        "score": 77.5,
        "price": 99.99,
        "pvp": 149.99,
        "offer": "Oferta Black Friday hasta el 30/11/2026",
        "asin": "B0DQSK8Y52",
        "review": "https://www.lighttherapyinsiders.com/nanoleaf-light-therapy-mask-review-best-under-300/",
        "waves": [(639, "roja"), (848, "NIR"), (460, "azul"), (518, "verde")],
        "dose": 6.5,
        "dose_note": "6,5 J/cm² en 10 min",
        "seller": "Amazon",
        "cons": "Correa, poca cobertura en labios, mandíbula y barbilla, y el infrarrojo cercano no se puede apagar.",
        "recommended": True,
        "avoid": False,
    },
    {
        "id": "inia",
        "name": "INIA Glow Máscara LED Facial 4D Inalámbrica Expanded Range 940",
        "short": "INIA Glow",
        "score": 77.5,
        "price": 169.99,
        "pvp": 199.99,
        "offer": "",
        "asin": "B0GFNT1252",
        "review": "https://www.lighttherapyinsiders.com/inia-glow-4d-review-great-red-light-mask-but-one-big-problem/",
        "waves": [(630, "roja"), (660, "roja"), (850, "NIR"), (940, "NIR")],
        "dose": 10.8,
        "dose_note": "10,8 J/cm² en 10 min",
        "seller": "Amazon",
        "cons": "Pesada e incómoda, según la review.",
        "recommended": False,
        "avoid": False,
    },
    {
        "id": "lumalux",
        "name": "Project E Beauty LumaLux Face Pro",
        "short": "LumaLux Face Pro",
        "score": 77.5,
        "price": 439.00,
        "pvp": None,
        "offer": "No es la LumaLux Face V2",
        "asin": "B0DLK4HWCV",
        "review": "https://www.lighttherapyinsiders.com/lumalux-pro-led-mask-project-es-led-mask-reviewed/",
        "waves": [(630, "roja"), (850, "NIR"), (1070, "NIR")],
        "dose": 3.8,
        "dose_note": "3,8 J/cm² en 3 min (sesión por defecto)",
        "seller": "Amazon",
        "cons": "La sesión por defecto se queda por debajo de la zona de 5–9 J/cm². Hay algo de 1.070 nm, fuera de la ventana de 810–850 nm.",
        "recommended": False,
        "avoid": False,
    },
    {
        "id": "currentbody",
        "name": "CurrentBody LED Mask Series 2",
        "short": "CurrentBody Series 2",
        "score": 68.5,
        "price": 449.99,
        "pvp": None,
        "offer": "",
        "asin": "B0DHRW819R",
        "review": "https://www.lighttherapyinsiders.com/currentbody-series-2-ledmask-review/",
        "waves": [(630, "roja"), (830, "NIR"), (1072, "NIR")],
        "dose": 11.2,
        "dose_note": "11,2 J/cm² en 10 min",
        "seller": "Amazon",
        "cons": "Irradiancia medida de 18,5 mW/cm² frente a 30 mW/cm² anunciados.",
        "recommended": False,
        "avoid": False,
    },
    {
        "id": "omnilux",
        "name": "Omnilux Contour Face",
        "short": "Omnilux Contour",
        "score": 60.5,
        "price": 419.00,
        "pvp": None,
        "offer": "Vendedor externo",
        "asin": "B08NCGWVPY",
        "review": "https://www.lighttherapyinsiders.com/2025-omnilux-contour-mask-review/",
        "waves": [(630, "roja"), (830, "NIR")],
        "dose": 16.0,
        "dose_note": "16 J/cm² en 10 min",
        "seller": "Vendedor externo",
        "cons": "Dosis alta para 10 min; la review sugiere 6–7 min. La ficha de Amazon.es es de un vendedor externo.",
        "recommended": False,
        "avoid": False,
    },
    {
        "id": "foreo",
        "name": "Foreo FAQ 202",
        "short": "Foreo FAQ 202",
        "score": 41.5,
        "price": 503.40,
        "pvp": 839.00,
        "offer": "",
        "asin": "B0BY982DFD",
        "review": "https://www.lighttherapyinsiders.com/foreo-faq-202-led-mask-review/",
        "waves": [],
        "dose": None,
        "dose_note": "Sin dato",
        "seller": "Amazon",
        "cons": "La peor nota del grupo: salida muy baja y sin infrarrojo cercano aprovechable. No recomendada.",
        "recommended": False,
        "avoid": True,
    },
]


def es_num(value: float, decimals: int) -> str:
    text = f"{value:.{decimals}f}"
    return text.replace(".", ",")


def amazon(asin: str) -> str:
    return f"https://www.amazon.es/dp/{asin}?tag={TAG}"


def index_of(mask: dict) -> float:
    return mask["score"] / mask["price"] * 100


def euro(value: float) -> str:
    return f"{es_num(value, 2)} €"


def rank_rows() -> list[list[str]]:
    ordered = sorted(MASKS, key=lambda mask: (-index_of(mask), mask["price"], mask["name"]))
    rows = [[
        "Puesto",
        "Mascarilla",
        "Nota Fergus",
        "Precio 25/11/2026",
        "Índice (nota / € × 100)",
        "Dosis por sesión",
        "Lectura",
    ]]
    for place, mask in enumerate(ordered, start=1):
        reading = "Recomendada" if mask["recommended"] else ("No recomendada" if mask["avoid"] else "Alternativa")
        rows.append([
            str(place),
            mask["short"],
            f"{es_num(mask['score'], 1)}/100",
            euro(mask["price"]),
            es_num(round(index_of(mask) + 1e-9, 2), 2),
            mask["dose_note"],
            reading,
        ])
    return rows


def a_amazon(mask: dict, label: str | None = None) -> str:
    text = html.escape(label or f"ver {mask['short']} en Amazon.es")
    return (
        f'<a href="{amazon(mask["asin"])}" target="_blank" '
        f'rel="sponsored nofollow noopener noreferrer">{text}</a>'
    )


def a_review(mask: dict) -> str:
    return (
        f'<a href="{html.escape(mask["review"])}" target="_blank" '
        f'rel="noopener noreferrer">review de {html.escape(mask["short"])} en Light Therapy Insiders</a>'
    )


def figure(name: str, alt: str, caption: str, width: int, height: int) -> str:
    src = f"{IMG}/{name}.svg"
    return (
        f'<figure><img src="{src}" alt="{html.escape(alt)}" width="{width}" height="{height}">'
        f"<figcaption>{caption}</figcaption></figure>"
    )


def price_bits(mask: dict) -> str:
    bits = [f"{euro(mask['price'])} el {CHECKED}"]
    if mask["pvp"] is not None:
        bits.append(f"PVP {euro(mask['pvp'])}")
    if mask["offer"]:
        bits.append(mask["offer"])
    return ", ".join(bits)


def card(mask: dict) -> str:
    waves = ", ".join(f"{nm} nm ({kind})" for nm, kind in mask["waves"]) or "sin longitud de onda aprovechable en los datos usados"
    extra = ""
    if mask["id"] == "currentbody":
        extra = (
            "<p>18,5 mW/cm² durante 600 s son 11,1 J/cm². Cuadra, dentro del redondeo, "
            "con los 11,2 J/cm² de la review. La ficha anuncia 30 mW/cm²: la cifra que ordena este artículo es la medida, no el anuncio.</p>"
        )
    if mask["id"] == "omnilux":
        extra = (
            "<p>Con 16 J/cm² en 10 min, 6 min equivalen a unos 9,6 J/cm² y 7 min a unos 11,2 J/cm². "
            "Es aritmética sobre la dosis publicada, no un protocolo. La propia review ya sugiere acortar a 6–7 min, "
            "y aun así esa franja queda en el borde alto o por encima de los 5–9 J/cm² que Fergus toma como zona útil.</p>"
        )
    if mask["id"] == "lumalux":
        extra = (
            "<p>Los 1.070 nm aparecen como un componente menor. No los tratamos como si fueran la ventana de 810–850 nm, "
            "que es donde hay más literatura de fotobiomodulación en piel.</p>"
        )
    status = "No recomendada. " if mask["avoid"] else ("Es la que compraríamos de este listado. " if mask["recommended"] else "")
    return (
        f"<p>{status}Nota {es_num(mask['score'], 1)}/100. {html.escape(mask['dose_note'])}. "
        f"Longitudes: {html.escape(waves)}. Precio: {html.escape(price_bits(mask))}. "
        f"{html.escape(mask['cons'])}</p>"
        f"{extra}"
        f"<p>{a_review(mask)}. Ficha: {a_amazon(mask)} (ASIN {mask['asin']}).</p>"
    )


def blocks() -> list[dict]:
    nanoleaf = MASKS[0]
    items: list[dict] = []

    def add(block_id: str, kind: str, **fields):
        items.append({"id": block_id, "type": kind, **fields})

    add("intro-1", "text", html=(
        "<p>Este ranking ordena las mascarillas LED faciales que, a 25 de noviembre de 2026, "
        "tienen ficha en amazon.es y nota publicada por Alex Fergus en Light Therapy Insiders. "
        "El Cuantificador mide relojes y pulseras frente a una banda de pecho; estas mascarillas no las hemos medido nosotros. "
        "Las notas, las longitudes de onda y las dosis salen de esas reviews, enlazadas una a una. "
        "Los precios salen de amazon.es. Precio consultado el 25/11/2026: puede cambiar, y la oferta de la Nanoleaf termina el 30/11/2026.</p>"
        "<p>No es un tratamiento ni una promesa de resultado en la piel. La nota es la que publica Fergus; "
        "aquí no la convertimos en un porcentaje de arrugas menos. La fotobiomodulación tiene literatura, y también límites: los citamos abajo.</p>"
    ))
    add("metodo-h", "heading", text="Cómo se calcula el índice calidad-precio", level=2)
    add("metodo-1", "text", html=(
        "<p>El índice es la nota de Fergus (sobre 100) dividida por el precio en euros y multiplicada por 100. "
        "Son puntos de nota por cada 100 €. A igual nota, queda delante la más barata. "
        "Redondeamos el índice a dos decimales. No entra la comisión de afiliado, ni el PVP tachado, ni una opinión de confort que no esté en la review.</p>"
        "<p>La Nanoleaf, la INIA Glow y la LumaLux Face Pro empatan a 77,5. El precio las separa: 99,99 €, 169,99 € y 439,00 €. "
        "Por eso la Nanoleaf es la recomendada de este listado, no porque la nota sea más alta.</p>"
        "<p>Quedan fuera, a propósito, dos modelos con más nota en Fergus y sin ficha en Amazon España: "
        "la LumaLux Face V2 (80/100; no es la Face Pro de este ranking) y la MitoGlow (78/100). "
        "Sin precio contrastado en amazon.es no entran en el índice.</p>"
    ))
    add("ranking-h", "heading", text="Ranking calidad-precio en Amazon.es", level=2)
    add("table-ranking", "table", title="Índice calidad-precio con precio consultado el 25/11/2026", table_origin="editorial", rows=rank_rows())
    add("ranking-nota", "text", html=(
        "<p>Precio consultado el 25/11/2026. La columna de dosis es la de la sesión que publica cada review "
        "(10 minutos, o 3 minutos en la LumaLux Face Pro). La Foreo FAQ 202 no tiene dosis utilizable: no ponemos un cero.</p>"
        + figure(
            "nota-precio",
            "Gráfico de dispersión: nota de Alex Fergus frente al precio en euros. La Nanoleaf queda arriba a la izquierda, con 77,5 puntos y 99,99 euros.",
            "Nota de Fergus frente al precio del 25/11/2026. Arriba y a la izquierda es mejor relación nota/precio. La Foreo queda abajo y a la derecha.",
            880,
            540,
        )
    ))
    add("reco-h", "heading", text="La recomendada: Nanoleaf", level=2)
    add("reco-1", "text", html=(
        "<p>Con 77,5/100 y 99,99 € (PVP 149,99 €, oferta Black Friday hasta el 30/11/2026) la Nanoleaf suma el índice más alto, 77,51. "
        "La sesión de 10 minutos entrega 6,5 J/cm², dentro de la zona de unos 5–9 J/cm² que Fergus usa al reseñar mascarillas. "
        "Roja a 639 nm e infrarrojo cercano a 848 nm: las dos ventanas con más literatura. Además trae azul a 460 nm y verde a 518 nm.</p>"
        f"<p>Los peros están en la review y conviene leerlos antes de comprarla: {html.escape(nanoleaf['cons'])} "
        "Si te importa tratar solo con rojo, esta mascarilla no deja apagar el infrarrojo cercano.</p>"
        f"<p>{a_review(nanoleaf)}. {a_amazon(nanoleaf, 'Nanoleaf LED Facial Therapy Mask en Amazon.es')}.</p>"
    ))
    add("fichas-h", "heading", text="El resto, de mejor a peor índice", level=2)
    for mask in sorted(MASKS, key=lambda item: -index_of(item)):
        if mask["id"] == "nanoleaf":
            continue
        add(f"ficha-{mask['id']}-h", "heading", text=(
            f"{mask['short']}: no recomendada" if mask["avoid"] else mask["short"]
        ), level=3)
        add(f"ficha-{mask['id']}", "text", html=card(mask))
    add("dosis-h", "heading", text="Dosis: qué es un J/cm² y por qué más no es mejor", level=2)
    add("dosis-1", "text", html=(
        "<p>La irradiancia es la potencia por superficie, en mW/cm². La dosis, o fluencia, es esa irradiancia por el tiempo. "
        "En julios: mW/cm² × segundos / 1.000 = J/cm². Diez minutos son 600 segundos. "
        "Por eso una mascarilla puede anunciar muchos milivatios y, si la sesión es corta o la medida real es más baja, entregar poca energía.</p>"
        "<p>Fergus marca una zona útil de unos 5–9 J/cm² por sesión al comparar estas mascarillas. "
        "No es un umbral clínico universal. La ventana depende del tejido, de la longitud de onda y de la irradiancia. "
        "Lo que sí está descrito es un efecto bifásico: por debajo de cierto nivel no se observa respuesta y, por encima, la respuesta puede dejar de subir o invertirse. "
        "Huang, Chen, Carroll y Hamblin lo revisan en <a href=\"https://doi.org/10.2203/dose-response.09-027.Hamblin\" target=\"_blank\" rel=\"noopener noreferrer\">Dose-Response (2009)</a>. "
        "Alargar la sesión «por si acaso» no es una forma rigurosa de mejorar el resultado.</p>"
        + figure(
            "dosis",
            "Barras de dosis en julios por centímetro cuadrado. Una banda marca la zona de 5 a 9. La Nanoleaf cae dentro; INIA, CurrentBody y Omnilux quedan por encima; LumaLux Face Pro, por debajo; Foreo, sin dato.",
            "Dosis de la sesión publicada. La banda es la zona de unos 5–9 J/cm² que usa Fergus, no una prescripción. La Foreo no tiene dosis: no se dibuja una barra en cero.",
            880,
            460,
        )
        + "<p>La Nanoleaf (6,5) cae dentro. La LumaLux Face Pro se queda en 3,8 J/cm² porque la sesión por defecto dura 3 minutos; no tenemos otra dosis medida, así que no inventamos un tiempo más largo. "
        "INIA (10,8), CurrentBody (11,2) y Omnilux (16) superan esa zona en la sesión de 10 minutos. "
        "En la Omnilux, la review ya propone 6–7 minutos en lugar de 10.</p>"
    ))
    add("ondas-h", "heading", text="Longitudes de onda y por qué se habla de mitocondrias", level=2)
    add("ondas-1", "text", html=(
        "<p>La fotobiomodulación (a veces llamada terapia de luz roja o LLLT) usa luz roja e infrarroja cercana a intensidades que no queman el tejido. "
        "No es un láser de corte. Los LED de una mascarilla entran en esa familia de fuentes, con mucha menos concentración que un láser clínico.</p>"
        "<p>La hipótesis con más recorrido es que el citocromo c oxidasa, el complejo IV de la cadena respiratoria mitocondrial, absorbe parte de esa luz. "
        "Tiene grupos hemo y cobre. Una lectura habitual es que los fotones despegan óxido nítrico que frena la enzima y, con ello, puede subir el transporte de electrones y el ATP. "
        "Es una hipótesis de mecanismo, no un efecto que estas mascarillas vayan a producir en la piel. "
        "Está resumida por de Freitas y Hamblin en <a href=\"https://doi.org/10.1109/JSTQE.2016.2561201\" target=\"_blank\" rel=\"noopener noreferrer\">IEEE Journal of Selected Topics in Quantum Electronics (2016)</a> "
        "y, con el encuadre de dosimetría y LED, por Chung y colegas en <a href=\"https://doi.org/10.1007/s10439-011-0454-7\" target=\"_blank\" rel=\"noopener noreferrer\">Annals of Biomedical Engineering (2012)</a>.</p>"
        "<p>En piel, la literatura se concentra en dos ventanas: rojo de unos 630–660 nm e infrarrojo cercano de unos 810–850 nm. "
        "El rojo se absorbe antes; el infrarrojo cercano penetra más hacia la dermis. "
        "940, 1.070 y 1.072 nm salen en algunas de estas mascarillas. Aquí no los contamos como si tuvieran el mismo respaldo que 830–850 nm.</p>"
        "<p>El azul (460 nm en la Nanoleaf) se ha estudiado sobre todo por otro motivo: las porfirinas de bacterias de la piel, no por el citocromo c oxidasa. "
        "El verde (518 nm) tiene bastante menos literatura. Tenerlos no suma puntos en este índice.</p>"
        + figure(
            "espectro",
            "Espectro de 400 a 1.100 nanómetros con las ventanas roja, de 630 a 660, e infrarroja cercana, de 810 a 850, y las longitudes de cada mascarilla. La Foreo no tiene longitudes en los datos.",
            "Cada punto es una longitud citada en la review de Fergus. Las bandas son las ventanas con más evidencia de fotobiomodulación en piel. Lo que cae fuera no lo tratamos como equivalente.",
            880,
            560,
        )
        + figure(
            "esquema-pbm",
            "Esquema cualitativo: la luz llega a la piel, el rojo se queda más superficial que el infrarrojo cercano, y la hipótesis de trabajo sitúa la absorción en el citocromo c oxidasa de la mitocondria.",
            "Esquema, no una medición. Sirve para situar la hipótesis (citocromo c oxidasa) y la diferencia de penetración entre rojo e infrarrojo cercano.",
            880,
            360,
        )
    ))
    add("uso-h", "heading", text="Cómo usarla sin convertirla en un tratamiento", level=2)
    add("uso-1", "text", html=(
        "<ul>"
        "<li>Piel limpia y seca, salvo que el manual pida otra cosa. El maquillaje y el protector opaco restan luz.</li>"
        "<li>Empieza por el tiempo de la sesión de fábrica. No lo alargues porque la sesión «se haya quedado corta»: en la zona alta, más dosis no implica más efecto.</li>"
        "<li>No mires de frente a los LED. Si el manual pide gafas o indica que cierres los ojos, hazlo. El azul es el que más molesta a la vista.</li>"
        "<li>La literatura de fotobiomodulación cuenta por semanas de uso repetido, no por una sesión. Una noche no reordena el colágeno.</li>"
        "<li>Si estás embarazada, tomas un fármaco fotosensibilizante o tienes una lesión cutánea sin diagnosticar, esto no sustituye una consulta. Este artículo no cubre esos casos.</li>"
        "</ul>"
    ))
    add("elegir-h", "heading", text="Cómo elegir entre las que sí están en Amazon.es", level=2)
    add("elegir-1", "text", html=(
        "<ol>"
        "<li>Mira la irradiancia medida, no la del anuncio. En la CurrentBody Series 2 la review mide 18,5 mW/cm² y la ficha dice 30.</li>"
        "<li>Comprueba la dosis de la sesión que vas a usar de verdad. La zona de 5–9 J/cm² es una referencia de Fergus, útil para comparar, no una receta.</li>"
        "<li>Prioriza rojo (630–660 nm) e infrarrojo cercano (810–850 nm). Trata 940–1.072 nm como un extra con menos respaldo en este uso.</li>"
        "<li>Lee la cobertura y el ajuste. La Nanoleaf flojea en labios, mandíbula y barbilla; la INIA se reseña como pesada.</li>"
        "<li>Mira quién vende. La Omnilux Contour de este ASIN está en un vendedor externo: el precio y la garantía no son los de Amazon como vendedor.</li>"
        "<li>Descarta la Foreo FAQ 202 si buscas una mascarilla de luz roja con infrarrojo cercano: es la peor nota y no hay dosis que enseñar.</li>"
        "</ol>"
    ))
    add("limites-h", "heading", text="Lo que este ranking no dice", level=2)
    add("limites-1", "text", html=(
        "<ul>"
        "<li>No hemos medido estas mascarillas. Si Fergus corrige una review, este texto queda desfasado hasta que se actualice.</li>"
        "<li>Una nota de 77,5 no es un 77,5 % de mejora en arrugas, acné o manchas. Tampoco es una nota de dispositivo médico.</li>"
        "<li>Los ensayos clínicos de luz roja usan aparatos, dosis y poblaciones distintas. No se pueden trasladar a una mascarilla doméstica solo porque el LED sea rojo.</li>"
        "<li>El precio es el visto el 25/11/2026. La oferta de la Nanoleaf está fechada hasta el 30/11/2026. Después, el índice puede cambiar de líder sin que cambie la nota.</li>"
        "<li>Los enlaces a Amazon llevan la etiqueta de afiliado elcuantificad-21. La comisión no modifica el orden: el índice usa la nota de un tercero y el precio de ese día. El aviso está en <a href=\"/afiliacion/\">enlaces de compra y afiliación</a>.</li>"
        "</ul>"
    ))
    add("faq-h", "heading", text="Preguntas frecuentes", level=2)
    faqs = faq()
    for number, item in enumerate(faqs, start=1):
        add(f"faq-q{number}", "heading", text=item["name"], level=3)
        add(f"faq-a{number}", "text", html=f"<p>{html.escape(item['text'])}</p>")
    add("fuentes-h", "heading", text="Fuentes", level=2)
    source_items = "".join(
        f"<li>{a_review(mask)}.</li>" for mask in MASKS
    )
    add("fuentes-1", "text", html=(
        "<p>Mediciones y notas de mascarillas, consultadas para este texto:</p><ul>"
        f"{source_items}</ul>"
        "<p>Mecanismo y dosis, literatura general. No estudian estos seis modelos:</p><ul>"
        "<li>Huang YY, Chen AC, Carroll JD, Hamblin MR. Biphasic dose response in low level light therapy. Dose-Response. 2009;7(4):358-383. "
        "<a href=\"https://doi.org/10.2203/dose-response.09-027.Hamblin\" target=\"_blank\" rel=\"noopener noreferrer\">doi:10.2203/dose-response.09-027.Hamblin</a>.</li>"
        "<li>Chung H, Dai T, Sharma SK, Huang YY, Carroll JD, Hamblin MR. The nuts and bolts of low-level laser (light) therapy. Annals of Biomedical Engineering. 2012;40(2):516-533. "
        "<a href=\"https://doi.org/10.1007/s10439-011-0454-7\" target=\"_blank\" rel=\"noopener noreferrer\">doi:10.1007/s10439-011-0454-7</a>.</li>"
        "<li>de Freitas LF, Hamblin MR. Proposed mechanisms of photobiomodulation or low-level light therapy. IEEE Journal of Selected Topics in Quantum Electronics. 2016;22(3):348-364. "
        "<a href=\"https://doi.org/10.1109/JSTQE.2016.2561201\" target=\"_blank\" rel=\"noopener noreferrer\">doi:10.1109/JSTQE.2016.2561201</a>.</li>"
        "</ul>"
    ))
    add("compra-h", "heading", text="Dónde consultar el precio", level=2)
    add("compra", "purchase", title="Fichas en Amazon.es", affiliate_notice=(
        "En calidad de Afiliado de Amazon, obtengo ingresos por las compras adscritas que cumplen los requisitos aplicables. "
        "Estos enlaces usan la etiqueta elcuantificad-21. Precio consultado el 25/11/2026; puede cambiar. "
        "La comisión no entra en el índice calidad-precio."
    ), links=[purchase_link(mask) for mask in sorted(MASKS, key=lambda item: -index_of(item))])
    return items


def purchase_link(mask: dict) -> dict:
    label = f"Amazon · {mask['short']}"
    if mask["avoid"]:
        label += " (no recomendada)"
    link = {
        "id": f"shop-amazon-{mask['id']}",
        "label": label,
        "url": amazon(mask["asin"]),
        "price": mask["price"],
        "original_price": mask["pvp"],
        "original_price_kind": "previous" if mask["pvp"] is not None else None,
        "availability": "unknown",
        "shipping_cost": None,
        "shipping_note": mask["offer"],
        "currency": "EUR",
        "price_checked_at": CHECKED_ISO,
    }
    return link


def faq() -> list[dict]:
    return [
        {
            "name": "¿Cuál compensa más en Amazon España?",
            "text": "La Nanoleaf LED Facial Therapy Mask: 77,5/100 y 99,99 € el 25/11/2026, con 6,5 J/cm² en 10 minutos. Es la primera del índice nota/precio. La oferta citada termina el 30/11/2026.",
        },
        {
            "name": "¿Más minutos o más potencia es mejor?",
            "text": "No. La dosis tiene un tramo útil y, por encima, la respuesta puede empeorar: es el efecto bifásico que revisan Huang y colegas (2009). Fergus usa unos 5–9 J/cm² como zona de comparación en estas mascarillas. No es una receta clínica.",
        },
        {
            "name": "¿Una nota de 77,5 significa que quita arrugas?",
            "text": "No. La nota es la de la review de Alex Fergus sobre esa mascarilla. No es un ensayo clínico nuestro ni un porcentaje de mejora en la piel.",
        },
        {
            "name": "¿Por qué la Foreo FAQ 202 está como no recomendada?",
            "text": "Porque Fergus le pone 41,5/100, la peor de este grupo, con una salida muy baja y sin infrarrojo cercano aprovechable. No hay dosis que citar. Además costaba 503,40 € (PVP 839 €) el 25/11/2026.",
        },
        {
            "name": "¿Y la LumaLux V2 o la MitoGlow, que tienen más nota?",
            "text": "Fergus publica 80 para la LumaLux Face V2 y 78 para la MitoGlow. No están en Amazon España, así que no entran en un ranking de amazon.es. La LumaLux de esta página es la Face Pro, no la V2.",
        },
        {
            "name": "¿El azul y el verde de la Nanoleaf cuentan como luz roja?",
            "text": "No. La evidencia de fotobiomodulación en piel se concentra en el rojo (unos 630–660 nm) y el infrarrojo cercano (unos 810–850 nm). El azul se ha estudiado aparte y el verde tiene mucho menos respaldo. No suman al índice.",
        },
        {
            "name": "¿Los enlaces son de afiliado?",
            "text": "Sí. Apuntan a amazon.es con la etiqueta elcuantificad-21. Si compras, el proyecto puede recibir una comisión sin coste añadido para ti. Esa comisión no cambia el orden del ranking.",
        },
    ]


TITLE = "Mejores mascarillas LED faciales en Amazon España (2026)"
SEO_TITLE = "Mascarillas LED en Amazon España 2026: ranking calidad-precio"
SEO_DESCRIPTION = (
    "Nanoleaf lidera (77,5 puntos, 99,99 €) el ranking de mascarillas LED en Amazon.es "
    "con notas de Alex Fergus. Dosis, longitudes de onda y límites."
)
SUMMARY = (
    "Ranking calidad-precio de las mascarillas LED con nota de Alex Fergus que se venden en amazon.es. "
    "La Nanoleaf (77,5 y 99,99 €) queda primera. Precio consultado el 25/11/2026."
)
COVER_ALT = (
    "Gráfico editorial del ranking: nota de Alex Fergus frente al precio en Amazon.es el 25/11/2026. "
    "No es una foto de las mascarillas."
)


def article() -> dict:
    return {
        "schema_version": 1,
        "content_type": "article",
        "article_kind": "guide",
        "public_path": PUBLIC_PATH,
        "published_at": CHECKED_ISO,
        "first_published_at": CHECKED_ISO,
        "updated_at": CHECKED_ISO,
        "faq": faq(),
        "article": {
            "schema_version": 1,
            "title": TITLE,
            "slug": SLUG,
            "summary": SUMMARY,
            "author": "Cipri",
            "cover": {
                "media_id": "",
                "path": f"{IMG}/portada.svg",
                "alt": COVER_ALT,
                "caption": "Gráfico del ranking, no una fotografía de producto.",
                "width": 1200,
                "height": 750,
            },
            "youtube": "",
            "categories": ["Luz roja", "Cuidado de la piel"],
            "tags": ["Mascarilla LED", "Amazon", "Fotobiomodulación", "Calidad-precio"],
            "blocks": blocks(),
            "seo_title": SEO_TITLE,
            "seo_description": SEO_DESCRIPTION,
        },
        "device": None,
        "media": {
            f"{IMG}/portada.svg": {
                "alt": COVER_ALT,
                "width": 1200,
                "height": 750,
                "mime": "image/svg+xml",
                "kind": "image",
            }
        },
        "og_image": {
            "path": f"{IMG}/portada.svg",
            "alt": COVER_ALT,
        },
        "version": f"published-{CHECKED_ISO}",
    }


def svg_header(width: int, height: int, title: str, desc: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'role="img" aria-labelledby="title desc">\n'
        f"<title>{html.escape(title)}</title>\n"
        f"<desc>{html.escape(desc)}</desc>\n"
        f'<rect width="{width}" height="{height}" fill="#ffffff"/>\n'
        '<style>text{font-family:Arial,Helvetica,sans-serif;fill:#161616}</style>\n'
    )


def scatter_svg() -> str:
    width, height = 880, 540
    left, right, top, bottom = 72, 28, 86, 64
    plot_w, plot_h = width - left - right, height - top - bottom
    x_max, y_min, y_max = 600, 35, 90

    def x_of(price: float) -> float:
        return left + price / x_max * plot_w

    def y_of(score: float) -> float:
        return top + (y_max - score) / (y_max - y_min) * plot_h

    parts = [svg_header(width, height, "Nota frente a precio", "Dispersión de la nota de Fergus y el precio en euros.")]
    parts.append(f'<text x="{left}" y="28" font-size="18" font-weight="700">Nota de Fergus frente al precio</text>')
    parts.append(f'<text x="{left}" y="50" font-size="13" fill="#505050">Precio consultado el {CHECKED}. Arriba e izquierda: más nota por euro.</text>')
    for tick in (0, 100, 200, 300, 400, 500, 600):
        x = x_of(tick)
        parts.append(f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{top + plot_h}" stroke="#e3e3e3"/>')
        parts.append(f'<text x="{x:.1f}" y="{top + plot_h + 22}" font-size="12" fill="#505050" text-anchor="middle">{tick} €</text>')
    for tick in (40, 50, 60, 70, 80, 90):
        y = y_of(tick)
        parts.append(f'<line x1="{left}" y1="{y:.1f}" x2="{left + plot_w}" y2="{y:.1f}" stroke="#e3e3e3"/>')
        parts.append(f'<text x="{left - 10}" y="{y + 4:.1f}" font-size="12" fill="#505050" text-anchor="end">{tick}</text>')
    parts.append(f'<text x="18" y="{top + plot_h / 2:.0f}" font-size="12" fill="#505050" transform="rotate(-90 18 {top + plot_h / 2:.0f})" text-anchor="middle">Nota / 100</text>')
    # Manual label offsets so 77.5 points and the cluster around 430 € stay readable.
    offsets = {
        "nanoleaf": (10, -14),
        "inia": (10, 18),
        "lumalux": (-8, -16),
        "currentbody": (12, 16),
        "omnilux": (-150, 18),
        "foreo": (-150, 4),
    }
    for mask in MASKS:
        x, y = x_of(mask["price"]), y_of(mask["score"])
        color = "#0055ff" if mask["recommended"] else ("#9a3b3b" if mask["avoid"] else "#161616")
        parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="7" fill="{color}"><title>{html.escape(mask["short"])}: {es_num(mask["score"], 1)} a {euro(mask["price"])}</title></circle>')
        dx, dy = offsets[mask["id"]]
        anchor = "start" if dx >= 0 else "end"
        parts.append(
            f'<text x="{x + dx:.1f}" y="{y + dy:.1f}" font-size="13" font-weight="700" fill="{color}" text-anchor="{anchor}">'
            f'{html.escape(mask["short"])} · {es_num(mask["score"], 1)}</text>'
        )
    parts.append("</svg>\n")
    return "".join(parts)


def dose_svg() -> str:
    width, height = 880, 460
    left, top = 210, 78
    bar_w, row_h = 560, 48
    max_dose = 18
    parts = [svg_header(width, height, "Dosis por sesión", "Barras de J por cm2 frente a la zona de 5 a 9.")]
    parts.append(f'<text x="32" y="32" font-size="18" font-weight="700">Dosis de la sesión publicada</text>')
    parts.append('<text x="32" y="52" font-size="12" fill="#505050">La banda azul es la zona de unos 5–9 J/cm² que usa Fergus. No es una prescripción.</text>')
    zone_x = left + 5 / max_dose * bar_w
    zone_w = (9 - 5) / max_dose * bar_w
    parts.append(f'<rect x="{zone_x:.1f}" y="{top - 8}" width="{zone_w:.1f}" height="{row_h * len(MASKS)}" fill="#edf3ff"/>')
    for tick in (0, 5, 9, 15):
        x = left + tick / max_dose * bar_w
        parts.append(f'<text x="{x:.1f}" y="{height - 28}" font-size="12" fill="#505050" text-anchor="middle">{tick}</text>')
    parts.append(f'<text x="{left + bar_w / 2:.0f}" y="{height - 8}" font-size="12" fill="#505050" text-anchor="middle">J/cm² por sesión</text>')
    for index, mask in enumerate(sorted(MASKS, key=lambda item: -index_of(item))):
        y = top + index * row_h
        parts.append(f'<text x="{left - 12}" y="{y + 20}" font-size="14" text-anchor="end">{html.escape(mask["short"])}</text>')
        if mask["dose"] is None:
            parts.append(f'<text x="{left + 8}" y="{y + 20}" font-size="14" fill="#9a3b3b">Sin dato · no se dibuja un cero</text>')
            continue
        length = mask["dose"] / max_dose * bar_w
        color = "#0055ff" if 5 <= mask["dose"] <= 9 else "#161616"
        parts.append(f'<rect x="{left}" y="{y}" width="{length:.1f}" height="28" fill="{color}"/>')
        parts.append(f'<text x="{left + length + 8:.1f}" y="{y + 19}" font-size="13">{es_num(mask["dose"], 1)}</text>')
    parts.append("</svg>\n")
    return "".join(parts)


def spectrum_svg() -> str:
    width, height = 880, 560
    left, right, top = 168, 36, 86
    axis_w = width - left - right
    nm_min, nm_max = 400, 1100

    def x_of(nm: float) -> float:
        return left + (nm - nm_min) / (nm_max - nm_min) * axis_w

    parts = [svg_header(width, height, "Longitudes de onda", "Ventanas roja e infrarroja cercana y picos de cada mascarilla.")]
    parts.append('<text x="32" y="32" font-size="18" font-weight="700">Longitudes de onda citadas en las reviews</text>')
    parts.append('<text x="32" y="56" font-size="13" fill="#505050">Banda rosa: 630–660 nm. Banda azul: 810–850 nm. Trazo azul: dentro. Trazo granate: fuera.</text>')
    band_y, band_h = 84, height - 130
    for start, end, fill in (
        (630, 660, "#ffe1e1"),
        (810, 850, "#edf3ff"),
    ):
        x, w = x_of(start), x_of(end) - x_of(start)
        parts.append(f'<rect x="{x:.1f}" y="{band_y}" width="{w:.1f}" height="{band_h}" fill="{fill}"/>')
    parts.append(f'<line x1="{left}" y1="{height - 46}" x2="{left + axis_w}" y2="{height - 46}" stroke="#161616"/>')
    for tick in (400, 500, 600, 700, 800, 900, 1000, 1100):
        x = x_of(tick)
        parts.append(f'<line x1="{x:.1f}" y1="{height - 46}" x2="{x:.1f}" y2="{height - 40}" stroke="#161616"/>')
        parts.append(f'<text x="{x:.1f}" y="{height - 22}" font-size="12" fill="#505050" text-anchor="middle">{tick}</text>')
    parts.append(f'<text x="{left + axis_w / 2:.0f}" y="{height - 4}" font-size="12" fill="#505050" text-anchor="middle">nanómetros</text>')
    rows = [mask for mask in sorted(MASKS, key=lambda item: -index_of(item))]
    for index, mask in enumerate(rows):
        y = 124 + index * 68
        parts.append(f'<text x="{left - 12}" y="{y + 6}" font-size="14" text-anchor="end">{html.escape(mask["short"])}</text>')
        parts.append(f'<line x1="{left}" y1="{y}" x2="{left + axis_w}" y2="{y}" stroke="#e3e3e3"/>')
        if not mask["waves"]:
            parts.append(f'<text x="{left + 8}" y="{y - 10}" font-size="13" fill="#9a3b3b">Sin longitud de onda en los datos usados</text>')
            continue
        for wave_index, (nm, kind) in enumerate(mask["waves"]):
            x = x_of(nm)
            in_window = (630 <= nm <= 660) or (810 <= nm <= 850)
            color = "#0055ff" if in_window else "#9a3b3b"
            label_y = y - 22 if wave_index % 2 == 0 else y + 32
            parts.append(f'<line x1="{x:.1f}" y1="{y - 16}" x2="{x:.1f}" y2="{y + 16}" stroke="{color}" stroke-width="3"/>')
            parts.append(f'<text x="{x:.1f}" y="{label_y}" font-size="11" fill="{color}" text-anchor="middle">{nm}</text>')
    parts.append("</svg>\n")
    return "".join(parts)


def schema_svg() -> str:
    width, height = 880, 360
    parts = [svg_header(width, height, "Esquema de la fotobiomodulación", "Esquema cualitativo de penetración y del citocromo c oxidasa.")]
    parts.append('<text x="32" y="34" font-size="18" font-weight="700">Esquema, no una medición</text>')
    parts.append('<text x="32" y="56" font-size="12" fill="#505050">Hipótesis de trabajo en la literatura. No demuestra el efecto de estas mascarillas.</text>')
    boxes = [
        (40, 100, "1", "Luz roja o NIR", "LED de la mascarilla,\nsin quemar la piel"),
        (250, 100, "2", "Piel", "El rojo se queda\nmás superficial"),
        (460, 100, "3", "Mitocondria", "Hipótesis: absorbe\nel citocromo c oxidasa"),
        (670, 100, "4", "Respuesta", "Más ATP es una\nhipótesis, no un hecho"),
    ]
    for x, y, number, title, body in boxes:
        parts.append(f'<rect x="{x}" y="{y}" width="170" height="150" fill="#f7f7f7" stroke="#e3e3e3"/>')
        parts.append(f'<text x="{x + 16}" y="{y + 32}" font-size="13" fill="#0055ff">{number}</text>')
        parts.append(f'<text x="{x + 16}" y="{y + 58}" font-size="16" font-weight="700">{html.escape(title)}</text>')
        for line_index, line in enumerate(body.split("\n")):
            parts.append(f'<text x="{x + 16}" y="{y + 88 + line_index * 20}" font-size="13" fill="#505050">{html.escape(line)}</text>')
    for x in (210, 420, 630):
        parts.append(f'<path d="M{x} 175 h28 l-8 -6 m8 6 l-8 6" fill="none" stroke="#0055ff" stroke-width="2"/>')
    parts.append('<text x="32" y="292" font-size="14">Rojo (~630–660 nm): se absorbe antes y se queda más superficial.</text>')
    parts.append('<text x="32" y="316" font-size="14">Infrarrojo cercano (~810–850 nm): penetra más. Fuera de esas ventanas hay menos evidencia.</text>')
    parts.append('<text x="32" y="344" font-size="13" fill="#505050">Mecanismo: de Freitas y Hamblin, 2016; Chung et al., 2012. Dosis bifásica: Huang et al., 2009.</text>')
    parts.append("</svg>\n")
    return "".join(parts)


def cover_svg() -> str:
    width, height = 1200, 750
    parts = [svg_header(width, height, "Ranking de mascarillas LED", "Portada editorial del ranking calidad-precio.")]
    parts.append('<rect width="1200" height="750" fill="#f7f7f7"/>')
    parts.append('<text x="72" y="120" font-size="18" fill="#0055ff" letter-spacing="2">EL CUANTIFICADOR · GUÍA</text>')
    parts.append('<text x="72" y="200" font-size="54" font-weight="700">Mascarillas LED</text>')
    parts.append('<text x="72" y="268" font-size="54" font-weight="700">en Amazon España</text>')
    parts.append(f'<text x="72" y="330" font-size="22" fill="#505050">Nota de Alex Fergus / precio del {CHECKED}</text>')
    ordered = sorted(MASKS, key=lambda mask: -index_of(mask))
    max_index = max(index_of(mask) for mask in ordered)
    for index, mask in enumerate(ordered):
        y = 400 + index * 48
        length = 80 + index_of(mask) / max_index * 620
        color = "#0055ff" if mask["recommended"] else ("#9a3b3b" if mask["avoid"] else "#161616")
        parts.append(f'<text x="72" y="{y}" font-size="18">{index + 1}. {html.escape(mask["short"])}</text>')
        parts.append(f'<rect x="360" y="{y - 18}" width="{length:.0f}" height="22" fill="{color}"/>')
        parts.append(f'<text x="{370 + length:.0f}" y="{y}" font-size="16">{es_num(round(index_of(mask) + 1e-9, 2), 2)}</text>')
    parts.append("</svg>\n")
    return "".join(parts)


def write_svgs() -> None:
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    files = {
        "nota-precio.svg": scatter_svg(),
        "dosis.svg": dose_svg(),
        "espectro.svg": spectrum_svg(),
        "esquema-pbm.svg": schema_svg(),
        "portada.svg": cover_svg(),
    }
    for name, content in files.items():
        (IMG_DIR / name).write_text(content, encoding="utf-8")


def write_article() -> None:
    payload = article()
    ARTICLE_PATH.parent.mkdir(parents=True, exist_ok=True)
    ARTICLE_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    index = {
        "articles": [
            {
                "slug": SLUG,
                "public_path": PUBLIC_PATH,
                "canonical": f"https://elcuantificador.com{PUBLIC_PATH}",
                "title": TITLE,
                "seo_title": SEO_TITLE,
                "seo_description": SEO_DESCRIPTION,
                "summary": SUMMARY,
                "article_kind": "guide",
                "published_at": CHECKED_ISO,
                "updated_at": CHECKED_ISO,
                "source": f"content/articles/{SLUG}.json",
                "charts": [
                    f"{IMG}/nota-precio.svg",
                    f"{IMG}/dosis.svg",
                    f"{IMG}/espectro.svg",
                    f"{IMG}/esquema-pbm.svg",
                    f"{IMG}/portada.svg",
                ],
            }
        ]
    }
    INDEX_PATH.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    description_len = len(SEO_DESCRIPTION)
    if not 120 <= description_len <= 160:
        raise SystemExit(f"seo_description fuera de rango: {description_len}")
    write_svgs()
    write_article()
    print(f"seo_description {description_len} caracteres")
    print(ARTICLE_PATH.relative_to(ROOT))
    for mask in sorted(MASKS, key=lambda item: -index_of(item)):
        print(f"{es_num(round(index_of(mask) + 1e-9, 2), 2):>6}  {mask['short']}")


if __name__ == "__main__":
    main()
