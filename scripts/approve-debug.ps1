param(
    [int]$TimeoutSec = 30,
    [switch]$Verbose
)

# Auto-click the Edge remote-debugging consent dialog.
# The dialog lives INSIDE the main Edge window (not a top-level window).
# Match the "Allow" button by its exact label using Unicode code points,
# because Windows PowerShell 5.1 reads this file as ANSI and would mangle
# any literal CJK characters written here.

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not ('Win32Mouse' -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Mouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public static void ClickAt(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(60);
    mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
  }
}
"@
}

# "Allow" in Simplified Chinese: U+5141 U+8BB8
$allowLabel = [string]([char]0x5141) + [char]0x8BB8
# Fallback for English UI
$allowFallback = 'Allow'

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$done = $false
$pids = @(Get-Process msedge -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

while ((Get-Date) -lt $deadline -and -not $done) {
    try {
        $wins = $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($w in $wins) {
            if ($pids -notcontains $w.Current.ProcessId) { continue }

            $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'MdTextButton')
            $btns = $w.FindAll($TS::Descendants, $cond)
            if ($btns.Count -eq 0) { continue }

            foreach ($b in $btns) {
                $label = $b.Current.Name
                if ($label -ne $allowLabel -and $label -ne $allowFallback) { continue }

                $r = $b.Current.BoundingRectangle
                if ($r.Width -le 0 -or $r.Height -le 0) { continue }

                $x = [int]($r.X + $r.Width / 2)
                $y = [int]($r.Y + $r.Height / 2)

                if ($Verbose) { Write-Output ("clicking '{0}' at {1},{2}" -f $label, $x, $y) }

                try { [Win32Mouse]::SetForegroundWindow([IntPtr]$w.Current.NativeWindowHandle) | Out-Null } catch {}
                Start-Sleep -Milliseconds 250
                [Win32Mouse]::ClickAt($x, $y)
                Write-Output ("clicked '{0}' at {1},{2}" -f $label, $x, $y)
                $done = $true
                break
            }
            if ($done) { break }
        }
    } catch {
        if ($Verbose) { Write-Output "scan error: $_" }
    }

    if (-not $done) { Start-Sleep -Milliseconds 700 }
}

if ($done) { exit 0 }
Write-Output 'timeout'
exit 1
