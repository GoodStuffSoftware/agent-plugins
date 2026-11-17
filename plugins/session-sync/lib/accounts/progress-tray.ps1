# progress-tray.ps1 - the Windows progress indicator of the session-sync account go-live.
#
# Started hidden by lib/accounts/progress.mjs (powershell.exe -STA -File, CREATE_NO_WINDOW). It shows ONE tray icon
# (System.Windows.Forms.NotifyIcon) driven by a message loop with no window, so it never takes focus. Everything it shows
# comes from go-live-result.json (written by the runner): the tooltip is progress.tooltip, the closing balloon is
# progress.headline. It never talks to the runner. It removes the icon and exits when
#   - the result is final: after the closing balloon, -LingerMs later;
#   - the runner process is gone and the result is not final;
#   - -MaxMs have passed (a safety net).
# Double click on the icon, or a click on a balloon, opens the go-live log.
#
# -DryRun uses no NotifyIcon and no message loop: it appends what it would show to -Trace (tests).
# ASCII only: Windows PowerShell 5.1 reads a BOM-less file in the ANSI code page.

param(
  [Parameter(Mandatory = $true)][string]$Result,
  [Parameter(Mandatory = $true)][int]$RunnerPid,
  [string]$Log = '',
  [string]$Title = 'Claude accounts',
  [string]$StartText = '',
  [string]$Icon = '',
  [int]$PollMs = 500,
  [int]$LingerMs = 8000,
  [int]$MaxMs = 10800000,
  [switch]$DryRun,
  [string]$Trace = ''
)

$ErrorActionPreference = 'Stop'
$script:ni = $null
$script:appCtx = $null
$script:lastTip = ''
$script:finalAt = -1
$script:done = $false
$script:clock = [System.Diagnostics.Stopwatch]::StartNew()
$FinalStatuses = @('ok', 'rolled_back', 'attention', 'failed')

function Write-Trace([string]$line) {
  if ($Trace) { try { Add-Content -LiteralPath $Trace -Value $line -Encoding ASCII } catch { } }
}

function Set-Tip([string]$text) {
  if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }   # NotifyIcon.Text limit
  if ($text -eq $script:lastTip) { return }
  $script:lastTip = $text
  if ($DryRun) { Write-Trace ('tip: ' + $text) } elseif ($script:ni) { $script:ni.Text = $text }
}

function Show-Balloon([string]$text) {
  if (-not $text) { return }
  if ($DryRun) { Write-Trace ('balloon: ' + $text); return }
  if ($script:ni) {
    $script:ni.BalloonTipTitle = $Title
    $script:ni.BalloonTipText = $text
    $script:ni.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
    $script:ni.ShowBalloonTip(10000)
  }
}

function Open-Log {
  if (-not $Log) { return }
  if ($DryRun) { Write-Trace 'open-log'; return }
  try { if (Test-Path -LiteralPath $Log) { Start-Process -FilePath 'notepad.exe' -ArgumentList ('"' + $Log + '"') } } catch { }
}

function Read-Result {
  try { return ([System.IO.File]::ReadAllText($Result) | ConvertFrom-Json) } catch { return $null }   # mid-rename or absent: keep the last text
}

function Test-RunnerAlive {
  try { $p = [System.Diagnostics.Process]::GetProcessById($RunnerPid); return (-not $p.HasExited) } catch { return $false }
}

function Stop-Tray([string]$why) {
  Write-Trace ('exit: ' + $why)
  $script:done = $true
  if ($script:ni) { try { $script:ni.Visible = $false; $script:ni.Dispose() } catch { }; $script:ni = $null }
  if ($script:appCtx) { try { $script:appCtx.ExitThread() } catch { } }
}

function Invoke-Tick {
  if ($script:done) { return }
  $elapsed = $script:clock.ElapsedMilliseconds
  if ($script:finalAt -ge 0) {
    if ($elapsed - $script:finalAt -ge $LingerMs) { Stop-Tray 'done' }
    return
  }
  if ($elapsed -ge $MaxMs) { Stop-Tray 'max-lifetime'; return }
  $r = Read-Result
  if ($r -and $r.progress) {
    if ($r.progress.tooltip) { Set-Tip ([string]$r.progress.tooltip) }
    $status = [string]$r.status
    if ($FinalStatuses -contains $status) {
      $line = [string]$r.progress.headline
      if ($status -ne 'ok' -and $Log) { $line = ($line + ' Click to open the log.').Trim() }
      Show-Balloon $line
      $script:finalAt = $elapsed
      return
    }
  }
  if (-not (Test-RunnerAlive)) { Stop-Tray 'runner-gone' }
}

function Invoke-SafeTick { try { Invoke-Tick } catch { Write-Trace ('tick error: ' + $_.Exception.Message) } }

Write-Trace 'start'

if ($DryRun) {
  Show-Balloon $StartText
  while (-not $script:done) {
    Invoke-SafeTick
    if (-not $script:done) { Start-Sleep -Milliseconds $PollMs }
  }
  exit 0
}

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $script:ni = New-Object System.Windows.Forms.NotifyIcon
  $icon = $null
  if ($Icon -and (Test-Path -LiteralPath $Icon)) { try { $icon = New-Object System.Drawing.Icon($Icon) } catch { $icon = $null } }
  if (-not $icon) { $icon = [System.Drawing.SystemIcons]::Information }
  $script:ni.Icon = $icon
  $script:ni.Text = 'Syncing Claude accounts'
  $script:ni.add_DoubleClick({ Open-Log })
  $script:ni.add_BalloonTipClicked({ Open-Log })
  $script:ni.Visible = $true
  Show-Balloon $StartText
  Invoke-SafeTick

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = $PollMs
  $timer.add_Tick({ Invoke-SafeTick })
  $timer.Start()
  $script:appCtx = New-Object System.Windows.Forms.ApplicationContext
  if (-not $script:done) { [System.Windows.Forms.Application]::Run($script:appCtx) }
  $timer.Stop()
  $timer.Dispose()
} catch {
  Write-Trace ('error: ' + $_.Exception.Message)
} finally {
  if ($script:ni) { try { $script:ni.Visible = $false; $script:ni.Dispose() } catch { } }
}
exit 0
