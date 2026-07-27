#!/usr/bin/env bash

set -euo pipefail

SOURCE_MONGO_URL="${SOURCE_MONGO_URL:-mongodb://127.0.0.1:27017}"
SOURCE_DB_NAME="${SOURCE_DB_NAME:-hr_analyzer}"
TARGET_DB_NAME="${TARGET_DB_NAME:-hr_analyzer}"

for command_name in mongodump mongorestore; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Falta ${command_name}. Instala MongoDB Database Tools antes de continuar." >&2
    exit 1
  fi
done

if [[ -z "${ATLAS_URI:-}" ]]; then
  read -r -s -p "Pega la URI mongodb+srv de Atlas: " ATLAS_URI
  echo
fi

if [[ "${ATLAS_URI}" != mongodb+srv://* && "${ATLAS_URI}" != mongodb://* ]]; then
  echo "La URI de Atlas no parece válida." >&2
  exit 1
fi

temporary_directory="$(mktemp -d)"
archive_path="${temporary_directory}/${SOURCE_DB_NAME}.archive.gz"
trap 'rm -rf "${temporary_directory}"' EXIT

echo "Creando una copia temporal de ${SOURCE_DB_NAME}..."
mongodump \
  --uri="${SOURCE_MONGO_URL}" \
  --db="${SOURCE_DB_NAME}" \
  --archive="${archive_path}" \
  --gzip

echo "Restaurando los datos en Atlas..."
mongorestore \
  --uri="${ATLAS_URI}" \
  --archive="${archive_path}" \
  --gzip \
  --nsFrom="${SOURCE_DB_NAME}.*" \
  --nsTo="${TARGET_DB_NAME}.*"

echo "Migración terminada. La base de datos de origen no se ha modificado."
