@echo off
REM agentchattr — starts server (if not running) + API agent wrapper
REM Usage: start_api_agent.bat <agent_name>
REM Example: start_api_agent.bat qwen
cd /d "%~dp0.."

set AGENT_NAME=%~1
if "%AGENT_NAME%"=="" (
    echo.
    echo   agentchattr — API Agent Launcher
    echo   ---------------------------------
    echo   Enter the agent name from your config.local.toml
    echo   Example: qwen, mistral, llama, deepseek
    echo.
    set /p AGENT_NAME="  Agent name: "
)
if "%AGENT_NAME%"=="" (
    echo   Error: No agent name provided.
    pause
    exit /b 1
)

call windows\bootstrap_python.bat ensure-venv
if %errorlevel% neq 0 exit /b %errorlevel%
call windows\bootstrap_python.bat start-server-if-needed
if %errorlevel% neq 0 exit /b %errorlevel%

"%AGENTCHATTR_VENV_PYTHON%" wrapper_api.py %AGENT_NAME%
pause
