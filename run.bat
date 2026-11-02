@echo off
setlocal
cd /d "%~dp0"
if not exist .venv (
    py -3 -m venv .venv || goto :fail
)
call .venv\Scripts\activate.bat
pip install -q -r requirements.txt || goto :fail
python server\main.py
goto :eof
:fail
echo Setup failed. Is Python 3.11+ installed?
pause
