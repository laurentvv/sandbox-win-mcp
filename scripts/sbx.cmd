@echo off
"%~dp0node.exe" "%~dp0src\cli.js" %*
exit /b %errorlevel%
