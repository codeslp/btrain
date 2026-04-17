@echo off
REM agentchattr — starts server (if not running) + Kimi wrapper
cd /d "%~dp0.."

call windows\bootstrap_python.bat ensure-venv
if %errorlevel% neq 0 exit /b %errorlevel%

REM Pre-flight: check that kimi CLI is installed
where kimi >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   Error: "kimi" was not found on PATH.
    echo   Install it first, then try again.
    echo.
    pause
    exit /b 1
)

call windows\bootstrap_python.bat start-server-if-needed
if %errorlevel% neq 0 exit /b %errorlevel%

"%AGENTCHATTR_VENV_PYTHON%" wrapper.py kimi
if %errorlevel% neq 0 (
    echo.
    echo   Agent exited unexpectedly. Check the output above.
    pause
)
