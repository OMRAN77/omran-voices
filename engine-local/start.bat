@echo off
rem Omran voice engine on this PC. The first run installs everything (10-20 minutes),
rem the next runs start right away. Keep the window open while the site uses it.
setlocal
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" goto run

set PY=
for %%V in (3.11 3.12) do (
  if not defined PY py -%%V -c "pass" >nul 2>nul && set "PY=py -%%V"
)
if not defined PY python -c "import sys; sys.exit(0 if sys.version_info[:2] in ((3,11),(3,12)) else 1)" >nul 2>nul && set "PY=python"
if not defined PY goto nopython

rem PyTorch build for the card: RTX 50 series needs CUDA 12.8, older cards CUDA 12.4.
set TORCH=2.6.0
set CUDA=cu124
nvidia-smi --query-gpu=name --format=csv,noheader > "%TEMP%\omran-gpu.txt" 2>nul
if errorlevel 1 (
  echo NVIDIA driver not found: install it from nvidia.com, then run start.bat again.
  pause
  exit /b 1
)
type "%TEMP%\omran-gpu.txt"
findstr /r /c:"RTX 50[0-9][0-9]" /c:"RTX PRO" "%TEMP%\omran-gpu.txt" >nul && set TORCH=2.7.1&& set CUDA=cu128

echo.
echo First run: installing the voice engine. This takes 10-20 minutes.
%PY% -m venv .venv || goto fail
".venv\Scripts\python" -m pip install --upgrade pip || goto fail
".venv\Scripts\python" -m pip install torch==%TORCH% torchaudio==%TORCH% --index-url https://download.pytorch.org/whl/%CUDA% || goto fail
".venv\Scripts\python" -m pip install -r requirements.txt torch==%TORCH% torchaudio==%TORCH% || goto fail
".venv\Scripts\python" -m pip install --no-deps chatterbox-tts==0.1.7 || goto fail

:run
".venv\Scripts\python" server.py
pause
exit /b 0

:nopython
echo Python 3.11 is not installed.
echo Download: https://www.python.org/downloads/release/python-3119/
echo In the installer tick "Add python.exe to PATH", then run start.bat again.
pause
exit /b 1

:fail
echo.
echo Installing failed. Take a photo of this window and send it.
rmdir /s /q .venv
pause
exit /b 1
