@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>&1
if %errorlevel%==0 (
  set "PYTHON_LAUNCHER=py"
) else (
  where python >nul 2>&1
  if errorlevel 1 goto :sem_python
  set "PYTHON_LAUNCHER=python"
)
start "Servidor local - Estoque no Bolso" cmd /k "cd /d ""%~dp0"" && %PYTHON_LAUNCHER% -m http.server 8000"
timeout /t 2 /nobreak >nul
start "" "http://localhost:8000"
echo.
echo O aplicativo esta disponivel em http://localhost:8000
 echo Para encerrar, feche a janela do servidor.
pause
exit /b 0

:sem_python
echo Python nao foi encontrado. Instale o Python ou use a extensao Live Server do VS Code.
pause
exit /b 1
