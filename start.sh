#!/usr/bin/env bash
# TallyUp — inicialização (Linux / macOS)
# Cria o ambiente virtual, instala as dependências e sobe o servidor.
set -e
cd "$(dirname "$0")"

PY=python3
command -v "$PY" >/dev/null 2>&1 || PY=python
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "Python 3.12+ não encontrado. Instale em https://python.org"
  exit 1
fi

if [ ! -d ".venv" ]; then
  echo "Criando ambiente virtual (.venv)..."
  "$PY" -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --upgrade pip >/dev/null
pip install -r requirements.txt

echo "Iniciando o servidor..."
# Repassa argumentos (ex.: ./start.sh --debug liga o modo diagnóstico de hotkeys)
python server.py "$@"
