# Editor de reviews del Cuantificador Deportivo

El panel existente incorpora un editor privado por dispositivo. En la ficha del
dispositivo, abre **Publicación web** para crear o continuar su borrador. Permite
redactar por bloques, insertar imágenes y vídeo de YouTube, seleccionar análisis
guardados, preparar puntuaciones y enlaces de compra, y comprobar la vista previa.

Guarda los cambios antes de salir. La vista previa utiliza el mismo renderizador
que la futura web pública. Guardar un borrador no lo publica; el botón de publicar
es una acción independiente. Los borradores de prueba de la copia local no se
importan a la nube al desplegar el código.

## Despliegue del panel

`render.yaml` conserva un único servicio, `cuantificador-deportivo`, que utiliza el
`Dockerfile` de la raíz: Angular 17 en `frontend/` y FastAPI en `backend/`.
`packages/review-renderer/` es una dependencia de compilación necesaria para el
editor, las gráficas y la pista compartida.

La web de vlogs tiene un ciclo de despliegue independiente. No es necesaria para
redactar y previsualizar desde el panel, y no se incluye en este despliegue.

Se mantienen las variables existentes `MONGO_URL`, `DB_NAME`, `APP_USERNAME` y
`APP_PASSWORD`. El editor exige autenticación configurada y utiliza colecciones
editoriales separadas; el arranque crea sus índices. No se ejecutan importaciones,
scripts de demo ni publicaciones automáticamente.

## Comprobaciones locales

Con MongoDB local y las dependencias del proyecto instaladas:

```sh
REVIEW_TEST_MONGO=1 PYTHONPATH=backend backend/venv/bin/python -m unittest discover -s backend/tests -p 'test_*.py'
npm run test:reviews --prefix frontend
npm run build --prefix frontend -- --configuration production
```

Las pruebas de integración crean y eliminan únicamente bases sintéticas
`review_test_*` en `127.0.0.1`. No utilizan Atlas ni publican datos reales.
