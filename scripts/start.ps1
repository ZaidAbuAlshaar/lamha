# Nazra clinic server - Windows PowerShell 5.1
# Usage:  powershell -ExecutionPolicy Bypass -File nazra\scripts\start.ps1
$ErrorActionPreference = "Stop"
$ServerDir = Join-Path (Split-Path -Parent $PSScriptRoot) "server"
$env:HF_HOME = "D:\models\hf"
$env:HF_HUB_OFFLINE = "1"
if (-not $env:NAZRA_LLM) { $env:NAZRA_LLM = "gemma4:e4b-it-qat" }
if (-not $env:NAZRA_FREE_VRAM) { $env:NAZRA_FREE_VRAM = "1" }
$Py = "D:\videos\tools\whisper-venv\Scripts\python.exe"
Write-Host "Nazra server -> http://0.0.0.0:8787  (LLM: $($env:NAZRA_LLM))"
& $Py -m uvicorn app:app --app-dir "$ServerDir" --host 0.0.0.0 --port 8787
