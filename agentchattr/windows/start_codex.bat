@echo off
REM agentchattr — starts server (if not running) + Codex wrapper
cd /d "%~dp0.."

call windows\bootstrap_python.bat ensure-venv
if %errorlevel% neq 0 exit /b %errorlevel%

REM Pre-flight: check that codex CLI is installed
where codex >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   Error: "codex" was not found on PATH.
    echo   Install it first, then try again.
    echo.
    pause
    exit /b 1
)

call windows\bootstrap_python.bat start-server-if-needed
if %errorlevel% neq 0 exit /b %errorlevel%

"%AGENTCHATTR_VENV_PYTHON%" wrapper.py codex
if %errorlevel% neq 0 (
    echo.
    echo   Agent exited unexpectedly. Check the output above.
    pause
)
