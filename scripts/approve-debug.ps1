param(
    [int]$TimeoutSec = 60,
    [switch]$Verbose
)

# Auto-click the Edge remote-debugging consent dialog.
#
# The dialog is NOT a top-level window: it lives inside the main Edge window,
# so it can only be found by searching descendants.
#
# Why it used to be slow: every poll did FindAll over the whole Edge UIA tree
# and materialised every MdTextButton before filtering. Edge's tree is huge
# (tab strip, omnibox, full page accessibility tree), so one scan took seconds;
# on top of that the loop slept 700ms between scans.
#
# Why the click sometimes did nothing: the old code did a physical mouse click,
# which only lands if Edge is the foreground window. SetForegroundWindow is
# often refused by Windows, so the cursor flew over the button and the click
# went nowhere. Now we use the UIA Invoke pattern first - it needs neither the
# mouse nor the foreground - and only fall back to a physical click.
#
# IMPORTANT: keep this file pure ASCII. Windows PowerShell 5.1 reads .ps1 as
# ANSI, so any UTF-8 CJK character here gets mangled and can break the parser.

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
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public const int SW_RESTORE = 9;

  // SetForegroundWindow alone is frequently refused by the shell;
  // stacking these calls raises the success rate a lot.
  public static bool ForceForeground(IntPtr hWnd) {
    ShowWindow(hWnd, SW_RESTORE);
    BringWindowToTop(hWnd);
    SetForegroundWindow(hWnd);
    SetActiveWindow(hWnd);
    return GetForegroundWindow() == hWnd;
  }

  public static void ClickAt(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(40);
    mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
  }
}
"@
}

# "Allow" in Simplified Chinese is U+5141 U+8BB8. Built from code points so the
# file stays ASCII.
$allowZh = [string]([char]0x5141) + [char]0x8BB8
$allowEn = 'Allow'

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

# Class is MdTextButton AND name is the localised Allow label.
$cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'MdTextButton')),
    (New-Object System.Windows.Automation.OrCondition(
        (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $allowZh)),
        (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $allowEn))
    ))
)

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$done = $false
$scans = 0
$started = Get-Date

while ((Get-Date) -lt $deadline -and -not $done) {
    $scans++
    $scanStart = Get-Date

    try {
        $pids = @(Get-Process msedge -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
        $wins = $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)

        foreach ($w in $wins) {
            if ($pids -notcontains $w.Current.ProcessId) { continue }

            # FindFirst stops at the first hit instead of building every match.
            $b = $w.FindFirst($TS::Descendants, $cond)
            if ($b -eq $null) { continue }

            $r = $b.Current.BoundingRectangle
            if ($r.Width -le 0 -or $r.Height -le 0) { continue }

            $x = [int]($r.X + $r.Width / 2)
            $y = [int]($r.Y + $r.Height / 2)
            $elapsed = [int]((Get-Date) - $started).TotalMilliseconds

            if ($Verbose) {
                Write-Output ("found at {0},{1} after {2}ms, scan #{3} took {4}ms" -f `
                    $x, $y, $elapsed, $scans, [int]((Get-Date) - $scanStart).TotalMilliseconds)
            }

            $invoked = $false
            try {
                $pattern = $null
                if ($b.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
                    $pattern.Invoke()
                    $invoked = $true
                }
            } catch {
                if ($Verbose) { Write-Output "invoke failed: $_" }
            }

            if (-not $invoked) {
                if ($Verbose) { Write-Output "no InvokePattern, falling back to physical click" }
                $fg = $false
                try { $fg = [Win32Mouse]::ForceForeground([IntPtr]$w.Current.NativeWindowHandle) } catch {}
                if (-not $fg -and $Verbose) { Write-Output "warning: could not bring Edge to foreground" }
                Start-Sleep -Milliseconds 150
                [Win32Mouse]::ClickAt($x, $y)
            }

            $how = if ($invoked) { 'invoke' } else { 'mouse' }
            Write-Output ("clicked via {0} at {1},{2} after {3}ms ({4} scans)" -f $how, $x, $y, $elapsed, $scans)
            $done = $true
            break
        }
    } catch {
        if ($Verbose) { Write-Output "scan error: $_" }
    }

    if (-not $done) { Start-Sleep -Milliseconds 150 }
}

if ($done) { exit 0 }
Write-Output ("timeout after {0} scans" -f $scans)
exit 1
