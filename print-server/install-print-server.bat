@echo off
setlocal enabledelayedexpansion

:: ---- Self-elevate to Administrator (BEFORE MENU) ----
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrative privileges...
  powershell -WindowStyle Hidden -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)
:: ----------------------------------------------------

REM === Service configuration ===
set SERVICE_NAME=print-server
set DISPLAY_NAME=FlickpayPOS Print Server
set APP_DIR=C:\print-server
set NSSM_EXE=%APP_DIR%\nssm.exe
set JAVA_EXE=%APP_DIR%\jre\bin\java.exe
set JAR_FILE=%APP_DIR%\print-server.jar
set LOG_DIR=%APP_DIR%\logs

:menu
cls
echo ==========================================
echo   FlickpayPOS Print Server - Service Tool
echo ==========================================
echo Service name : %SERVICE_NAME%
echo Display name : %DISPLAY_NAME%
echo Folder       : %APP_DIR%
echo ------------------------------------------
echo 1) Run print-server.jar (not a service)
echo 2) Install service
echo 3) Stop and uninstall service
echo 4) Exit
echo ==========================================
set /p choice=Choose an option (1-4): 

if "%choice%"=="1" goto runjar
if "%choice%"=="2" goto install
if "%choice%"=="3" goto uninstall
if "%choice%"=="4" goto end

echo Invalid choice. Try again.
pause
goto menu

:runjar
cls
echo === RUNNING PRINT SERVER (NOT A SERVICE) ===

REM --- Sanity checks ---
if not exist "%APP_DIR%" (
  echo ERROR: Missing folder "%APP_DIR%"
  pause
  goto menu
)
if not exist "%JAVA_EXE%" (
  echo ERROR: Missing bundled Java "%JAVA_EXE%"
  pause
  goto menu
)
if not exist "%JAR_FILE%" (
  echo ERROR: Missing JAR "%JAR_FILE%"
  pause
  goto menu
)

echo Using Java : "%JAVA_EXE%"
echo Running    : "%JAR_FILE%"
echo.
echo (Close this window or press Ctrl+C to stop.)
echo.

pushd "%APP_DIR%"
"%JAVA_EXE%" -jar "%JAR_FILE%"
popd

echo.
echo Process exited. Returning to menu...
pause
goto menu

:install
cls
echo === INSTALLING %DISPLAY_NAME% ===

REM --- Sanity checks ---
if not exist "%APP_DIR%" (
  echo ERROR: Missing folder "%APP_DIR%"
  pause
  goto menu
)
if not exist "%NSSM_EXE%" (
  echo ERROR: Missing "%NSSM_EXE%"
  pause
  goto menu
)
if not exist "%JAVA_EXE%" (
  echo ERROR: Missing bundled Java "%JAVA_EXE%"
  pause
  goto menu
)
if not exist "%JAR_FILE%" (
  echo ERROR: Missing JAR "%JAR_FILE%"
  pause
  goto menu
)

mkdir "%LOG_DIR%" 2>nul

echo Using NSSM : "%NSSM_EXE%"
echo Using Java : "%JAVA_EXE%"

REM --- Remove old service (safe if it doesn't exist) ---
"%NSSM_EXE%" stop %SERVICE_NAME% >nul 2>&1
"%NSSM_EXE%" remove %SERVICE_NAME% confirm >nul 2>&1

REM --- Install service ---
"%NSSM_EXE%" install %SERVICE_NAME% "%JAVA_EXE%" "-jar \"%JAR_FILE%\""
if errorlevel 1 (
  echo ERROR: NSSM install failed.
  pause
  goto menu
)

REM --- Configure service ---
"%NSSM_EXE%" set %SERVICE_NAME% DisplayName "%DISPLAY_NAME%"
"%NSSM_EXE%" set %SERVICE_NAME% AppDirectory "%APP_DIR%"
"%NSSM_EXE%" set %SERVICE_NAME% Start SERVICE_AUTO_START
"%NSSM_EXE%" set %SERVICE_NAME% AppExit Default Restart

REM --- Logging ---
"%NSSM_EXE%" set %SERVICE_NAME% AppStdout "%LOG_DIR%\stdout.log"
"%NSSM_EXE%" set %SERVICE_NAME% AppStderr "%LOG_DIR%\stderr.log"
"%NSSM_EXE%" set %SERVICE_NAME% AppRotateFiles 1
"%NSSM_EXE%" set %SERVICE_NAME% AppRotateOnline 1

REM --- Start service ---
"%NSSM_EXE%" start %SERVICE_NAME%
if errorlevel 1 (
  echo ERROR: Service failed to start. Check logs in "%LOG_DIR%".
  pause
  goto menu
)

echo.
echo SUCCESS: "%DISPLAY_NAME%" installed and started.
echo Logs: "%LOG_DIR%"
echo.
sc query %SERVICE_NAME%
pause
goto menu

:uninstall
cls
echo === STOPPING AND UNINSTALLING %DISPLAY_NAME% ===

if not exist "%NSSM_EXE%" (
  echo ERROR: Missing "%NSSM_EXE%"
  pause
  goto menu
)

REM --- Stop then remove ---
"%NSSM_EXE%" stop %SERVICE_NAME% >nul 2>&1
"%NSSM_EXE%" remove %SERVICE_NAME% confirm >nul 2>&1

echo.
echo Uninstall complete. Current status:
sc query %SERVICE_NAME%
echo.
echo (If it says the service does not exist, it has been fully removed.)
pause
goto menu

:end
endlocal
exit /b
