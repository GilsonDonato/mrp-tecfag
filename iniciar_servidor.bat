@echo off
title Tecfag MRP II - Inicializador do Servidor
echo ===================================================
echo   Tecfag MRP II - Inicializando Servidor Local
echo ===================================================

:: Verificar se o Node.js esta instalado (com fallback para instalacoes recem-concluidas)
where node >nul 2>nul
if %errorlevel% equ 0 goto node_ok

if exist "C:\Program Files\nodejs\node.exe" goto node_found_x64
if exist "C:\Program Files (x86)\nodejs\node.exe" goto node_found_x86

echo [ERRO] O Node.js nao foi encontrado no seu sistema.
echo Por favor, instale o Node.js para executar o servidor.
echo Voce pode baixar o instalador oficial em: https://nodejs.org/
echo.
pause
exit /b

:node_found_x64
set "PATH=%PATH%;C:\Program Files\nodejs"
goto node_ok

:node_found_x86
set "PATH=%PATH%;C:\Program Files (x86)\nodejs"
goto node_ok

:node_ok

:: Garantir que as dependencias estao instaladas e integras
node -e "require('express')" >nul 2>nul
if %errorlevel% equ 0 goto express_ok

echo.
echo [INFO] Instalando ou reparando dependencias do projeto (isso pode levar alguns segundos)...
call npm install

:express_ok

:: Iniciar o servidor e abrir o navegador
echo.
echo Iniciando o servidor local na porta 3000...
start "" "http://localhost:3000"
node server.js
if %errorlevel% equ 0 goto end

echo.
echo [ERRO] O servidor encontrou um problema e foi encerrado.
pause

:end
