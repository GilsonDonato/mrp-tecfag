@echo off
title Enviar Atualizacoes para o GitHub - Tecfag MRP II
echo ===================================================
echo   Enviando atualizacoes do MRP II para o GitHub...
echo ===================================================
echo.
echo Executando git push...
"C:\Program Files\Git\cmd\git.exe" push origin main
echo.
if %errorlevel% neq 0 (
    echo [ERRO] Ocorreu um problema ao enviar. 
    echo Se abrir uma janela do GitHub, por favor, realize o login para autorizar o envio.
) else (
    echo [SUCESSO] Atualizacao enviada com sucesso para o GitHub!
    echo O Render ira recompilar e atualizar o site em cerca de 1 a 2 minutos.
)
echo.
pause
