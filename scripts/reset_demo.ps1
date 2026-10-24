# Reset all demo data to the known starting state (wipes the DB, re-seeds every demo module).
# Usage: powershell -ExecutionPolicy Bypass -File nazra\scripts\reset_demo.ps1
$ServerDir = Join-Path (Split-Path -Parent $PSScriptRoot) "server"
& "D:\videos\tools\whisper-venv\Scripts\python.exe" -c "import sys; sys.path.insert(0, r'$ServerDir'); import demo; print('reset:', demo.reset_all())"
