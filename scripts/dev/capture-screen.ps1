param(
    [int]$Seconds = 30,
    [int]$IntervalMs = 1500,
    [string]$OutDir = 'C:\Users\24533\Desktop\xsuite\data\shots'
)

# Diagnostic: capture the full screen periodically to see what appears during CDP connect.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$end = (Get-Date).AddSeconds($Seconds)
$count = 0

while ((Get-Date) -lt $end) {
    try {
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $file = Join-Path $OutDir ('shot-{0}.png' -f ([DateTime]::Now.ToString('HHmmssfff')))
        $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose()
        $bmp.Dispose()
        $count++
    } catch { }
    Start-Sleep -Milliseconds $IntervalMs
}

Write-Output "saved $count shots to $OutDir"
