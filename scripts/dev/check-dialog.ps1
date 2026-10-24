Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$pids = @(Get-Process msedge -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

$wins = $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($w in $wins) {
    if ($pids -notcontains $w.Current.ProcessId) { continue }
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'MdTextButton')
    $btns = $w.FindAll($TS::Descendants, $cond)
    if ($btns.Count -gt 0) {
        Write-Output ("WINDOW: {0}  buttons={1}" -f $w.Current.Name, $btns.Count)
        foreach ($b in $btns) {
            $r = $b.Current.BoundingRectangle
            Write-Output ("  [{0}] {1}" -f $b.Current.Name, $r)
        }
    }
}
Write-Output "check done"
