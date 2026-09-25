@echo off
REM ============================================================
REM  Right-to-left Chinese classics reader - launcher
REM
REM  Always serves http://127.0.0.1:8899 and opens the browser.
REM  Browsers keep data (recent list / reading position / settings
REM  / offline cache) PER ADDRESS: 127.0.0.1:8899, localhost:8777
REM  and file:// are three different sites with separate storage.
REM  That is why the reading list looks empty when opened another way.
REM
REM  If the service is already running this only opens the browser
REM  again - no error, no second process.
REM
REM  MAINTAINER NOTE - keep this file ASCII-ONLY.
REM  cmd.exe mis-parses .bat files that mix non-ASCII bytes with
REM  "chcp 65001" (byte offsets no longer match characters, so
REM  comment lines end up executed as commands). All Chinese text
REM  is therefore printed by tools/serve.mjs, which is plain UTF-8
REM  and displays correctly once the console is in codepage 65001.
REM ============================================================

setlocal

chcp 65001 >nul
cd /d "%~dp0"
title Gushi Reader

set "NODE="
if exist "C:\Users\DELL\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" set "NODE=C:\Users\DELL\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if not defined NODE for /d %%D in ("C:\Users\DELL\.workbuddy\binaries\node\versions\*") do if exist "%%D\node.exe" set "NODE=%%D\node.exe"
if not defined NODE for /f "delims=" %%P in ('where node 2^>nul') do set "NODE=%%P"

if not defined NODE goto nonode
if not exist "%~dp0tools\serve.mjs" goto noscript

echo.
echo   starting local service on http://127.0.0.1:8899 ...
echo.

"%NODE%" "%~dp0tools\serve.mjs"
set "RC=%ERRORLEVEL%"

if "%RC%"=="3" goto already

echo.
echo   service stopped.
pause
exit /b 0

:already
REM Service was already up; serve.mjs printed the explanation and opened
REM the browser. Keep the window visible for a moment so it is readable.
REM (ping instead of timeout: timeout needs stdin and fails when redirected)
ping -n 4 127.0.0.1 >nul
exit /b 0

:nonode
echo.
echo   Node.js not found - cannot start the local service.
echo   You may still double-click index.html to read (all features work,
echo   but reading records are not shared with the 127.0.0.1:8899 entry).
echo   See README.md for details.
echo.
pause
exit /b 1

:noscript
echo.
echo   tools\serve.mjs is missing - cannot start the local service.
echo   Please make sure the whole book folder was copied together.
echo   See README.md for details.
echo.
pause
exit /b 1
