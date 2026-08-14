@echo off
REM TallyUp - rodar os testes (Windows)
REM Cria o ambiente virtual se preciso, instala as dependencias de dev e roda o pytest.
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python nao encontrado. Instale o Python 3.12+ em https://python.org
  echo Marque a opcao "Add Python to PATH" durante a instalacao.
  pause
  exit /b 1
)

if not exist ".venv" (
  echo Criando ambiente virtual ^(.venv^)...
  python -m venv .venv
)

call ".venv\Scripts\activate.bat"
python -m pip install --upgrade pip >nul
pip install -q -r requirements-dev.txt

echo Rodando os testes...
REM Repassa argumentos (ex.: test.bat -k groups roda so os testes de grupos)
python -m pytest tests/ %*
pause
