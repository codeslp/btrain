@echo off
if /I "%~1"=="ensure-venv" goto ensure_venv
if /I "%~1"=="start-server-if-needed" goto start_server_if_needed

echo.
echo   Error: unsupported bootstrap action "%~1".
echo.
exit /b 1

:ensure_venv
setlocal
set "MIN_PYTHON_MAJOR=3"
set "MIN_PYTHON_MINOR=11"
set "VENV_PYTHON=.venv\Scripts\python.exe"

if exist ".venv" if not exist "%VENV_PYTHON%" (
    echo Recreating .venv for this platform...
    rmdir /s /q .venv
)

if exist "%VENV_PYTHON%" (
    call :command_meets_minimum "%VENV_PYTHON%"
    if errorlevel 1 (
        echo Recreating .venv for a Python %MIN_PYTHON_MAJOR%.%MIN_PYTHON_MINOR%+ runtime...
        rmdir /s /q .venv
    )
)

if not exist "%VENV_PYTHON%" (
    call :resolve_python_bin
    if errorlevel 1 exit /b 1
    echo Creating virtual environment with %PYTHON_VERSION_TEXT%...
    %PYTHON_BIN% -m venv .venv
    if errorlevel 1 (
        echo Error: failed to create .venv with %PYTHON_BIN%.
        exit /b 1
    )
)

set "EXPECTED_HASH="
for /f "usebackq delims=" %%H in (`"%VENV_PYTHON%" -c "import hashlib, pathlib; print(hashlib.sha256(pathlib.Path('requirements.txt').read_bytes()).hexdigest())"`) do set "EXPECTED_HASH=%%H"
if not defined EXPECTED_HASH (
    echo Error: failed to read requirements.txt.
    exit /b 1
)

set "CURRENT_HASH="
if exist ".venv\.requirements.sha256" set /p CURRENT_HASH=<".venv\.requirements.sha256"

if not "%CURRENT_HASH%"=="%EXPECTED_HASH%" (
    echo Syncing Python dependencies from requirements.txt...
    "%VENV_PYTHON%" -m pip install -q -r requirements.txt
    if errorlevel 1 (
        echo Error: failed to install Python dependencies.
        exit /b 1
    )
    > ".venv\.requirements.sha256" echo %EXPECTED_HASH%
)

endlocal & set "AGENTCHATTR_VENV_PYTHON=.venv\Scripts\python.exe" & exit /b 0

:resolve_python_bin
set "PYTHON_BIN="
set "PYTHON_VERSION_TEXT="

if defined AGENTCHATTR_PYTHON (
    call :command_meets_minimum "%AGENTCHATTR_PYTHON%"
    if not errorlevel 1 (
        set "PYTHON_BIN=%AGENTCHATTR_PYTHON%"
        goto :python_found
    )
)

where py >nul 2>&1
if not errorlevel 1 (
    for %%V in (3.13 3.12 3.11) do (
        call :command_meets_minimum "py -%%V"
        if not errorlevel 1 (
            set "PYTHON_BIN=py -%%V"
            goto :python_found
        )
    )
)

for %%P in (python3.13 python3.12 python3.11 python3 python) do (
    call :command_meets_minimum "%%P"
    if not errorlevel 1 (
        set "PYTHON_BIN=%%P"
        goto :python_found
    )
)

echo Python %MIN_PYTHON_MAJOR%.%MIN_PYTHON_MINOR%+ is required but no compatible interpreter was found.
echo Install Python 3.11, 3.12, or 3.13, or set AGENTCHATTR_PYTHON to a compatible interpreter.
exit /b 1

:python_found
for /f "delims=" %%I in ('%PYTHON_BIN% --version 2^>^&1') do set "PYTHON_VERSION_TEXT=%%I"
exit /b 0

:command_meets_minimum
set "CHECK_CMD=%~1"
cmd /c "%CHECK_CMD% -c \"import sys; raise SystemExit(0 if sys.version_info[:2] >= (%MIN_PYTHON_MAJOR%, %MIN_PYTHON_MINOR%) else 1)\"" >nul 2>&1
exit /b %errorlevel%

:is_server_running
netstat -ano | findstr :8300 | findstr LISTENING >nul 2>&1
exit /b %errorlevel%

:start_server_if_needed
call :is_server_running
if not errorlevel 1 exit /b 0

start "agentchattr server" cmd /c "\"%AGENTCHATTR_VENV_PYTHON%\" run.py"

set /a WAIT_COUNT=0
:wait_server
call :is_server_running
if not errorlevel 1 exit /b 0

if %WAIT_COUNT% geq 30 (
    echo.
    echo   Error: agentchattr server did not start within 30 seconds.
    echo.
    exit /b 1
)

set /a WAIT_COUNT+=1
timeout /t 1 /nobreak >nul
goto wait_server
