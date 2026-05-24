param(
  [string]$WorkbookPath = "C:\Users\user\OneDrive\BozokMerkez\BozokMerkez.xlsx",
  [int]$IntervalMs = 1000
)

$ErrorActionPreference = "SilentlyContinue"
$lastSourceTick = 0L

function Get-SourceTick {
  $dir = Split-Path -Parent $WorkbookPath
  $files = @("bozok-live.csv", "kasalar.csv", "formul.csv", "blokeler.csv")
  $ticks = 0L
  foreach ($file in $files) {
    $path = Join-Path $dir $file
    if (Test-Path $path) {
      $ticks = [Math]::Max($ticks, (Get-Item $path).LastWriteTimeUtc.Ticks)
    }
  }
  return $ticks
}

while ($true) {
  try {
    $tick = Get-SourceTick
    if ($tick -gt $lastSourceTick) {
      $excel = [Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application")
      if ($excel) {
        foreach ($workbook in @($excel.Workbooks)) {
          if ([string]::Equals($workbook.FullName, $WorkbookPath, [StringComparison]::OrdinalIgnoreCase)) {
            $workbook.RefreshAll()
            $excel.CalculateFull()
            $lastSourceTick = $tick
            break
          }
        }
      }
    }
  } catch {}
  Start-Sleep -Milliseconds $IntervalMs
}
