@echo off
REM ============================================================
REM  Right-to-left Chinese classics reader - build script
REM  Usage:  build.bat "book.pdf"
REM          build.bat "D:\scans\folder"
REM          build.bat a.jpg b.jpg c.jpg
REM  Add --help for the full option list (printed by Python).
REM
REM  MAINTAINER NOTE - keep this file ASCII-ONLY; see start.bat
REM  for why (cmd.exe mis-parses non-ASCII .bat under chcp 65001).
REM ============================================================

setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "PYV=C:\Users\DELL\.workbuddy\binaries\python\envs\gushi\Scripts\python.exe"

if not exist "%PYV%" (
  echo [env] creating virtualenv ...
  "C:\Users\DELL\.workbuddy\binaries\python\versions\3.13.12\python.exe" -m venv "C:\Users\DELL\.workbuddy\binaries\python\envs\gushi"
  "%PYV%" -m pip install --quiet --disable-pip-version-check pymupdf pillow
)

if "%~1"=="" (
  "%PYV%" "%~dp0tools\build_reader.py" --help
  echo.
  pause
  exit /b 1
)

"%PYV%" "%~dp0tools\build_reader.py" %*

echo.
pause
