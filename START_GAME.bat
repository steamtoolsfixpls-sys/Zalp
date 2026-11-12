@echo off
cd /d "%~dp0"
node tools\serve.mjs 8081 --open
pause
