@echo off
"%~dp0node.exe" "%~dp0src\server.js" %*
exit /b %errorlevel%
