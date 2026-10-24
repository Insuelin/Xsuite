# 诊断：持续列出顶层窗口，发现新窗口时打印它的类名、标题和按钮。
# 用法: powershell -File diagnose-windows.ps1 [-TimeoutSec 60]

param([int]$TimeoutSec = 60)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$seen = @{}

Write-Output "scanning for $TimeoutSec seconds..."

while ((Get-Date) -lt $deadline) {
  try {
    $wins = $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($w in $wins) {
      $cls = $w.Current.ClassName
      $name = $w.Current.Name
      $key = "$cls|$name"
      if ($seen.ContainsKey($key)) { continue }
      $seen[$key] = $true

      $ts = (Get-Date).ToString('HH:mm:ss.fff')
      Write-Output "[$ts] class='$cls' name='$name' pid=$($w.Current.ProcessId)"

      $btnCond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'MdTextButton')
      $btns = $w.FindAll($TS::Descendants, $btnCond)
      foreach ($b in $btns) {
        $r = $b.Current.BoundingRectangle
        Write-Output "    btn MdTextButton '$($b.Current.Name)' rect=($([int]$r.X),$([int]$r.Y),$([int]$r.Width),$([int]$r.Height))"
      }

      # 也列出所有 Button 类型控件，看看实际是什么
      $allBtn = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
      $ab = $w.FindAll($TS::Descendants, $allBtn)
      if ($ab.Count -gt 0 -and $btns.Count -eq 0) {
        foreach ($b in $ab) {
          $r = $b.Current.BoundingRectangle
          Write-Output "    btn(any) class='$($b.Current.ClassName)' name='$($b.Current.Name)' rect=($([int]$r.X),$([int]$r.Y),$([int]$r.Width),$([int]$r.Height))"
        }
      }
    }
  } catch { }
  Start-Sleep -Milliseconds 150
}
Write-Output "done"
