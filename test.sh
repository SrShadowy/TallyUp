#!/usr/bin/env bash
# TallyUp — rodar os testes (Linux / macOS)
# Cria o ambiente virtual se preciso, instala as dependências de dev e roda o pytest.
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
pip install -q -r requirements-dev.txt

echo "Rodando os testes..."
# Repassa argumentos (ex.: ./test.sh -k groups roda só os testes de grupos;
#                        ./test.sh -x para no primeiro erro)
python -m pytest tests/ "$@"
