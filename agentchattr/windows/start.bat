@echo off
REM agentchattr — starts the server only
cd /d "%~dp0.."
call windows\bootstrap_python.bat ensure-venv
if %errorlevel% neq 0 exit /b %errorlevel%

"%AGENTCHATTR_VENV_PYTHON%" run.py
echo.
echo === Server exited with code %ERRORLEVEL% ===
pause
