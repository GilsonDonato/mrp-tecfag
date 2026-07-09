@echo off
title Tecfag MRP II - Inicializador do Servidor
echo ===================================================
echo   Tecfag MRP II - Inicializando Servidor Local
echo ===================================================

:: Verificar se o Node.js esta instalado
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERRO] O Node.js nao foi encontrado no seu sistema.
    echo Por favor, instale o Node.js para executar o servidor.
    echo Voce pode baixar o instalador oficial em: https://nodejs.org/
    echo.
    pause
    exit /b
)

:: Se a pasta node_modules nao existir, rodar npm install
if not exist node_modules (
    echo.
    echo Instalando dependencias do projeto (isso pode levar alguns segundos na primeira execucao)...
    call npm install
)

:: Iniciar o servidor e abrir o navegador
echo.
echo Iniciando o servidor local na porta 3000...
start "" "http://localhost:3000"
node server.js
