# Cloudflare quick tunnel: gives the HTTPS URL phones need for camera/mic access.
# Usage:  powershell -ExecutionPolicy Bypass -File nazra\scripts\tunnel.ps1
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:8787
