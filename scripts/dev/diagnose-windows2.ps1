# 诊断 v2：扫描 msedge 进程所有窗口的子元素，找 MdTextButton 和标题。
param([int]$TimeoutSec = 45)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$seen = @{}
$edgePids = @(Get-Process msedge -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

Write-Output "edge pids: $($edgePids -join ',')"
Write-Output "scanning $TimeoutSec s..."

while ((Get-Date) -lt $deadline) {
  try {
    $wins = $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($w in $wins) {
      if ($edgePids -notcontains $w.Current.ProcessId) { continue }

      $cls = $w.Current.ClassName
      $name = $w.Current.Name
      $key = "$cls|$name"
      if ($seen.ContainsKey($key)) { continue }
      $seen[$key] = $true
      Write-Output "[$((Get-Date).ToString('HH:mm:ss.fff'))] WIN class='$cls' name='$name'"

      try {
        $btnCond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'MdTextButton')
        $btns = $w.FindAll($TS::Descendants, $btnCond)
        foreach ($b in $btns) {
          $r = $b.Current.BoundingRectangle
          Write-Output "    MdTextButton '$($b.Current.Name)' rect=($([int]$r.X),$([int]$r.Y),$([int]$r.Width),$([int]$r.Height))"
        }
        if ($btns.Count -eq 0) {
          $allCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
          $ab = $w.FindAll($TS::Descendants, $allCond)
          if ($ab.Count -gt 0 -and $ab.Count -lt 15) {
            foreach ($b in $ab) {
              $r = $b.Current.BoundingRectangle
              Write-Output "    Button class='$($b.Current.ClassName)' name='$($b.Current.Name)' rect=($([int]$r.X),$([int]$r.Y),$([int]$r.Width),$([int]$r.Height))"
            }
          }
        }
      } catch { Write-Output "    (child scan error)" }
    }
  } catch { }
  Start-Sleep -Milliseconds 400
}
Write-Output "done"
