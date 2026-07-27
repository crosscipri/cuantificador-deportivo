# Despliegue gratuito

La aplicación se despliega como un único servicio Docker en Render:

- FastAPI sirve la API bajo `/api`.
- FastAPI también sirve la compilación de Angular y sus rutas.
- MongoDB Atlas conserva la base de datos fuera del contenedor.

## 1. Crear MongoDB Atlas M0

1. Entra en [MongoDB Atlas](https://cloud.mongodb.com/) y crea un proyecto.
2. Crea un cluster `M0` gratuito.
3. En **Database Access**, crea un usuario con una contraseña segura.
4. En **Network Access**, permite temporalmente conexiones desde cualquier IP
   (`0.0.0.0/0`). Después del despliegue puedes restringirlo a las IP salientes
   que Render muestra para el servicio.
5. Pulsa **Connect > Drivers** y copia la URI `mongodb+srv://...`, sustituyendo
   `<password>` por la contraseña codificada para URL.

El cluster gratuito dispone de 512 MB. La base local ocupa aproximadamente
95 MB, así que cabe con margen.

## 2. Copiar todos los datos locales

Con MongoDB local arrancado, ejecuta desde la raíz del repositorio:

```bash
chmod +x scripts/migrate_to_atlas.sh
./scripts/migrate_to_atlas.sh
```

El script pide la URI de Atlas sin mostrarla, crea una copia temporal y migra
las colecciones a `hr_analyzer`. No borra ni modifica la base local.

## 3. Crear el servicio gratuito de Render

1. Entra en [Render](https://dashboard.render.com/) con tu cuenta de GitHub.
2. Elige **New > Blueprint** y selecciona este repositorio.
3. Render detectará `render.yaml`.
4. Introduce estas variables cuando las solicite:
   - `MONGO_URL`: la misma URI de Atlas.
   - `APP_PASSWORD`: una contraseña segura para entrar en la aplicación.
   - `ANTHROPIC_API_KEY`: la clave usada por los análisis de IA.
5. Confirma el Blueprint y espera a que `/api/health` aparezca como saludable.

Render asignará una URL del tipo
`https://cuantificador-deportivo.onrender.com`. El plan gratuito se suspende
tras un periodo sin visitas, por lo que la primera apertura puede tardar cerca
de un minuto. Los datos no se pierden porque permanecen en Atlas.

Al abrir la web, el navegador pedirá las credenciales. El usuario configurado
por defecto es `cuantificador` y la contraseña será la de `APP_PASSWORD`.
