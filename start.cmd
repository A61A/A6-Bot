@echo off
rem Nodeline bot launcher - creates the venv on first run, then starts the bot.
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [setup] Creating Python 3.12 virtual environment...
    py -3.12 -m venv .venv
    if errorlevel 1 (
        echo [error] Could not create venv. Install Python 3.12 from https://www.python.org/downloads/
        pause
        exit /b 1
    )
)

call ".venv\Scripts\activate.bat" >nul 2>&1

echo [setup] Checking dependencies...
python -m pip install --quiet --disable-pip-version-check -r requirements.txt
if errorlevel 1 goto :err

echo.
echo [boot] Starting Nodeline bot...
echo =================================
python bot.py
goto :end

:err
echo [error] Dependency install failed - see output above.
pause
exit /b 1

:end
pause