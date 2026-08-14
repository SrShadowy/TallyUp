@echo off
REM TallyUp - inicializacao (Windows)
REM Cria o ambiente virtual, instala as dependencias e sobe o servidor.
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
pip install -r requirements.txt

echo Iniciando o servidor...
REM Repassa argumentos (ex.: start.bat --debug liga o modo diagnostico de hotkeys)
python server.py %*
pause
