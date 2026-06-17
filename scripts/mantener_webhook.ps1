while ($true) {
  try {
    $r = Invoke-RestMethod -Uri "https://api.telegram.org/bot8666644752:AAG6-1RS8mp5l-MdT3KQeKl4mGA6R3G0SY4/setWebhook?url=https://livescore-bot-qpoh.onrender.com" -TimeoutSec 5
    if (-not $r.ok) { Write-Host "Error: $($r.description)" }
  } catch { Write-Host "Fallo conexion: $_" }
  Start-Sleep -Seconds 2
}
