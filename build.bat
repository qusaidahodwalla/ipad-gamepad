@echo off
setlocal
cd /d "%~dp0"
rem Builds the desktop app into dist\iPad Gamepad\ (one folder). Run it from a normal command prompt.
if not exist .venv (
    py -3 -m venv .venv || goto :fail
)
call .venv\Scripts\activate.bat
pip install -q -r requirements-app.txt || goto :fail
python -c "import vgamepad" 2>nul || echo NOTE: vgamepad is not installed in .venv, so the build will have no XBOX features. See README.
pyinstaller --noconfirm --clean "iPad Gamepad.spec" || goto :fail
echo.
echo Built: dist\iPad Gamepad\iPad Gamepad.exe
goto :eof
:fail
echo Build failed.
pause
