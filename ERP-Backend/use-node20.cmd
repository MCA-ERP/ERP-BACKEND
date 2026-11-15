@echo off
rem Runs any command with Node 20 from nvm-windows for this one command only.
rem It does not change the Node version used by the rest of the machine.
rem
rem   use-node20 npm run dev
rem   use-node20 npm test
rem   use-node20 node -v
set "NODE20=C:\nvm\v20.18.0"
if not exist "%NODE20%\node.exe" (
  echo Node 20 was not found at %NODE20%. Install it with: nvm install 20.18.0
  exit /b 1
)
set "PATH=%NODE20%;%PATH%"
%*
