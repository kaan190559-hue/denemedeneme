param(
  [string]$CenterDir = "C:\Users\user\OneDrive\BozokMerkez",
  [string]$OutputPath = "C:\Users\user\OneDrive\BozokMerkez\BozokMerkez.xlsx"
)

$ErrorActionPreference = "Stop"

if (!(Test-Path $CenterDir)) {
  New-Item -ItemType Directory -Force -Path $CenterDir | Out-Null
}

$csvSources = @(
  @{ Sheet = "DP_LIVE"; File = "bozok-live.csv" },
  @{ Sheet = "KASALAR"; File = "kasalar.csv" },
  @{ Sheet = "FORMUL"; File = "formul.csv" },
  @{ Sheet = "BLOKELER"; File = "blokeler.csv" }
)

foreach ($source in $csvSources) {
  $path = Join-Path $CenterDir $source.File
  if (!(Test-Path $path)) {
    throw "Kaynak CSV yok: $path"
  }
}

$excel = $null
$workbook = $null

try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $excel.ScreenUpdating = $false

  $workbook = $excel.Workbooks.Add()

  while ($workbook.Worksheets.Count -gt 1) {
    $workbook.Worksheets.Item($workbook.Worksheets.Count).Delete()
  }

  $summary = $workbook.Worksheets.Item(1)
  $summary.Name = "OZET"

  function Add-Sheet([string]$Name) {
    $sheet = $workbook.Worksheets.Add([Type]::Missing, $workbook.Worksheets.Item($workbook.Worksheets.Count))
    $sheet.Name = $Name
    return $sheet
  }

  foreach ($source in $csvSources) {
    $sheet = Add-Sheet $source.Sheet
    $csvPath = Join-Path $CenterDir $source.File
    $query = $sheet.QueryTables.Add("TEXT;$csvPath", $sheet.Range("A1"))
    $query.TextFileParseType = 1
    $query.TextFileSemicolonDelimiter = $true
    $query.TextFileCommaDelimiter = $false
    $query.TextFilePlatform = 65001
    $query.AdjustColumnWidth = $true
    $query.RefreshOnFileOpen = $true
    $query.BackgroundQuery = $false
    $query.Name = "q_$($source.Sheet)"
    [void]$query.Refresh($false)

    $used = $sheet.UsedRange
    $used.Font.Name = "Segoe UI"
    $used.Font.Size = 10
    $used.Borders.LineStyle = 1
    $sheet.Rows.Item(1).Font.Bold = $true
    $sheet.Rows.Item(1).Interior.Color = 0x1F1F1F
    $sheet.Rows.Item(1).Font.Color = 0xFFFFFF
    $sheet.Activate()
    $excel.ActiveWindow.FreezePanes = $false
    $sheet.Range("A2").Select() | Out-Null
    $excel.ActiveWindow.FreezePanes = $true
  }

  $summary.Activate()
  $summary.Cells.Clear()
  $summary.Range("A1").Value2 = "BOZOK MERKEZ"
  $summary.Range("A2").Value2 = "OneDrive klasorundeki CSV dosyalarindan beslenen merkez Excel"
  $summary.Range("A4").Value2 = "Son Guncelleme"
  $summary.Range("B4").FormulaLocal = "=DP_LIVE!I2"
  $summary.Range("A5").Value2 = "Kaynak Cihaz"
  $summary.Range("B5").FormulaLocal = "=DP_LIVE!H2"

  $summary.Range("A7").Value2 = "ANLIK PANEL"
  $summary.Range("A8").Value2 = "Devir"
  $summary.Range("B8").FormulaLocal = "=DP_LIVE!C2"
  $summary.Range("A9").Value2 = "Yatirim"
  $summary.Range("B9").FormulaLocal = "=DP_LIVE!D2"
  $summary.Range("A10").Value2 = "Cekim"
  $summary.Range("B10").FormulaLocal = "=DP_LIVE!E2"
  $summary.Range("A11").Value2 = "Yat. Kom."
  $summary.Range("B11").FormulaLocal = "=DP_LIVE!F2"
  $summary.Range("A12").Value2 = "Panel Kasa"
  $summary.Range("B12").FormulaLocal = "=DP_LIVE!G2"

  $summary.Range("D7").Value2 = "KASA DAGILIMI"
  $summary.Range("D8").Value2 = "Atlas"
  $summary.Range("E8").FormulaLocal = '=SUMIF(KASALAR!A:A;"atlas";KASALAR!F:F)'
  $summary.Range("D9").Value2 = "Ecem"
  $summary.Range("E9").FormulaLocal = '=SUMIF(KASALAR!A:A;"ecem";KASALAR!F:F)'
  $summary.Range("D10").Value2 = "Aslan"
  $summary.Range("E10").FormulaLocal = '=SUMIF(KASALAR!A:A;"aslan";KASALAR!F:F)'
  $summary.Range("D11").Value2 = "Ares"
  $summary.Range("E11").FormulaLocal = '=SUMIF(KASALAR!A:A;"ares";KASALAR!F:F)'
  $summary.Range("D12").Value2 = "Elimizdeki Kasa"
  $summary.Range("E12").FormulaLocal = "=SUM(E8:E11)"

  $summary.Range("G7").Value2 = "KASA FORMULU"
  $summary.Range("G8").Value2 = "Gider"
  $summary.Range("H8").FormulaLocal = '=SUMIF(FORMUL!B:B;"gider";FORMUL!E:E)'
  $summary.Range("G9").Value2 = "Dunun Borcu"
  $summary.Range("H9").FormulaLocal = '=SUMIF(FORMUL!B:B;"borcDusum";FORMUL!E:E)'
  $summary.Range("G10").Value2 = "Dunun Alacagi"
  $summary.Range("H10").FormulaLocal = '=SUMIF(FORMUL!B:B;"alacak";FORMUL!E:E)'
  $summary.Range("G11").Value2 = "Borc-Kom"
  $summary.Range("H11").FormulaLocal = "=H9+H10-B11"
  $summary.Range("G12").Value2 = "Kalmasi Gereken"
  $summary.Range("H12").FormulaLocal = "=H8+H11"
  $summary.Range("G13").Value2 = "Kalan"
  $summary.Range("H13").FormulaLocal = "=B12-E12"
  $summary.Range("G14").Value2 = "Fark"
  $summary.Range("H14").FormulaLocal = "=H12-H13"

  $summary.Range("A16").Value2 = "Kullanim"
  $summary.Range("A17").Value2 = "Veri sekmesinden Tumunu Yenile yapinca ayni klasordeki CSV'ler tekrar okunur."
  $summary.Range("A18").Value2 = "Panel tarafinda degisen veri once CSV/JSON merkeze, sonra bu Excel dosyasina akar."

  $summary.Range("A1:H1").Merge()
  $summary.Range("A2:H2").Merge()
  $summary.Range("A16:H16").Merge()
  $summary.Range("A17:H17").Merge()
  $summary.Range("A18:H18").Merge()

  $summary.Range("A1").Font.Size = 22
  $summary.Range("A1").Font.Bold = $true
  $summary.Range("A1").Font.Color = 0xD9EFFF
  $summary.Range("A2").Font.Color = 0xB7C2D5
  $summary.Range("A1:H20").Font.Name = "Segoe UI"
  $summary.Range("A1:H20").Font.Size = 11
  $summary.Range("A1:H20").Interior.Color = 0x111827
  $summary.Range("A1:H20").Font.Color = 0xE5E7EB
  $summary.Range("A7:B12").Interior.Color = 0x1E293B
  $summary.Range("D7:E12").Interior.Color = 0x1D2E26
  $summary.Range("G7:H14").Interior.Color = 0x2B2230
  foreach ($address in @("A7:B7", "D7:E7", "G7:H7")) {
    $summary.Range($address).Font.Bold = $true
    $summary.Range($address).Interior.Color = 0x3A2D15
  }
  $currencyFormat = "#.##0 ""$([char]0x20BA)"""
  foreach ($address in @("B8:B12", "E8:E12", "H8:H14")) {
    $summary.Range($address).NumberFormatLocal = $currencyFormat
  }
  $summary.Range("A4:H18").Borders.LineStyle = 1
  $summary.Columns.Item("A:H").AutoFit() | Out-Null
  $summary.Range("A1").Select() | Out-Null

  try {
    $chartObjects = $summary.ChartObjects()
    $chartObject = $chartObjects.Add(340, 270, 300, 210)
    $chart = $chartObject.Chart
    $chart.ChartType = 5
    $chart.SetSourceData($summary.Range("D8:E11"))
    $chart.HasTitle = $true
    $chart.ChartTitle.Text = "Kasa Dagilimi"
    $chart.Refresh()
  } catch {
    # Grafik desteklenmezse dosya yine kullanılabilir kalsın.
  }

  foreach ($sheet in @("DP_LIVE", "KASALAR", "FORMUL", "BLOKELER")) {
    $workbook.Worksheets.Item($sheet).Visible = -1
  }

  if (Test-Path $OutputPath) {
    Remove-Item -LiteralPath $OutputPath -Force
  }
  $workbook.SaveAs($OutputPath, 51)
  $workbook.Close($true)
  $excel.Quit()

  Write-Output $OutputPath
} finally {
  if ($workbook) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($workbook) | Out-Null }
  if ($excel) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
