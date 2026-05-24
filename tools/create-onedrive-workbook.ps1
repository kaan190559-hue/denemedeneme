param(
  [string]$CenterDir = "C:\Users\user\OneDrive\BozokMerkez",
  [string]$OutputPath = "C:\Users\user\OneDrive\BozokMerkez\BozokMerkez.xlsx",
  [string]$RenderBaseUrl = "https://bozok-financial-dashboard.onrender.com"
)

$ErrorActionPreference = "Stop"

if (!(Test-Path $CenterDir)) {
  New-Item -ItemType Directory -Force -Path $CenterDir | Out-Null
}

$csvSources = @(
  @{ Sheet = "DP_LIVE"; File = "bozok-live.csv"; Endpoint = "/api/excel/bozok-live.csv" },
  @{ Sheet = "KASALAR"; File = "kasalar.csv"; Endpoint = "/api/excel/kasalar.csv" },
  @{ Sheet = "FORMUL"; File = "formul.csv"; Endpoint = "/api/excel/formul.csv" },
  @{ Sheet = "BLOKELER"; File = "blokeler.csv"; Endpoint = "/api/excel/blokeler.csv" }
)

$useRender = -not [string]::IsNullOrWhiteSpace($RenderBaseUrl)

if (-not $useRender) {
  foreach ($source in $csvSources) {
    $path = Join-Path $CenterDir $source.File
    if (!(Test-Path $path)) {
      throw "Kaynak CSV yok: $path"
    }
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
    if ($useRender) {
      $base = $RenderBaseUrl.TrimEnd("/")
      $csvSource = "TEXT;$base$($source.Endpoint)"
    } else {
      $csvPath = Join-Path $CenterDir $source.File
      $csvSource = "TEXT;$csvPath"
    }
    $query = $sheet.QueryTables.Add($csvSource, $sheet.Range("A1"))
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

  $kasaSheet = Add-Sheet "KASA_YAPMA"
  $kasaSheet.Cells.Clear()
  $kasaSheet.Activate()
  $excel.ActiveWindow.DisplayGridlines = $false

  Add-Type -AssemblyName System.Drawing
  function Xl-Color([string]$Hex) {
    $value = $Hex.TrimStart("#")
    $red = [Convert]::ToInt32($value.Substring(0, 2), 16)
    $green = [Convert]::ToInt32($value.Substring(2, 2), 16)
    $blue = [Convert]::ToInt32($value.Substring(4, 2), 16)
    return [System.Drawing.ColorTranslator]::ToOle([System.Drawing.Color]::FromArgb($red, $green, $blue))
  }

  $cBg = Xl-Color "#0F172A"
  $cHeader = Xl-Color "#101624"
  $cPanel = Xl-Color "#172033"
  $cPanel2 = Xl-Color "#1E293B"
  $cBorder = Xl-Color "#3C4A5F"
  $cText = Xl-Color "#E5E7EB"
  $cMuted = Xl-Color "#9FB0C8"
  $cGold = Xl-Color "#F6DF9D"
  $cGreenFill = Xl-Color "#123827"
  $cGreen = Xl-Color "#3CD69C"
  $cRedFill = Xl-Color "#3A171B"
  $cRed = Xl-Color "#FF6675"
  $cBlueFill = Xl-Color "#143142"
  $cBlue = Xl-Color "#70D6FF"
  $cAmberFill = Xl-Color "#34290E"
  $cPurpleFill = Xl-Color "#241B35"
  $cSlateFill = Xl-Color "#202A3A"
  $cWhite = Xl-Color "#FFFFFF"
  $cLight = Xl-Color "#F8FAFC"
  $cLightHeader = Xl-Color "#E9EDF3"
  $cDarkText = Xl-Color "#0F172A"

  $kasaSheet.Tab.Color = $cBlue

  $kasaSheet.Range("A1:N34").Interior.Color = $cBg
  $kasaSheet.Range("A1:N34").Font.Name = "Segoe UI"
  $kasaSheet.Range("A1:N34").Font.Color = $cText
  $kasaSheet.Range("A1:N34").Font.Size = 10
  foreach ($column in 1..14) {
    $kasaSheet.Columns.Item($column).ColumnWidth = 14
  }
  $kasaSheet.Columns.Item(1).ColumnWidth = 23
  $kasaSheet.Columns.Item(4).ColumnWidth = 18
  $kasaSheet.Columns.Item(7).ColumnWidth = 21
  $kasaSheet.Columns.Item(10).ColumnWidth = 30
  $kasaSheet.Columns.Item(13).ColumnWidth = 14
  $kasaSheet.Columns.Item(14).ColumnWidth = 9
  foreach ($row in 1..34) {
    $kasaSheet.Rows.Item($row).RowHeight = 22
  }
  $kasaSheet.Rows.Item(1).RowHeight = 30
  $kasaSheet.Rows.Item(2).RowHeight = 26
  foreach ($row in 4..7) {
    $kasaSheet.Rows.Item($row).RowHeight = 24
  }

  $currencyPrefixFormat = """$([char]0x20BA)"" #.##0,00"
  $currencyZeroFormat = """$([char]0x20BA)"" #.##0,00;[Red]-""$([char]0x20BA)"" #.##0,00;""$([char]0x20BA)"" 0,00"

  function Set-PremiumBorder($Range, [int]$Color = 0) {
    if ($Color -eq 0) { $Color = $cBorder }
    $Range.Borders.LineStyle = 1
    $Range.Borders.Color = $Color
    $Range.Borders.Weight = 2
  }

  function Set-Card([string]$Address, [string]$Label, [string]$Formula, [int]$Fill, [int]$Accent) {
    $range = $kasaSheet.Range($Address)
    $range.Interior.Color = $Fill
    Set-PremiumBorder $range $cBorder
    $labelRange = $kasaSheet.Range($range.Cells.Item(1, 1), $range.Cells.Item(1, $range.Columns.Count))
    $valueRange = $kasaSheet.Range($range.Cells.Item(2, 1), $range.Cells.Item(3, $range.Columns.Count))
    $labelRange.Merge()
    $valueRange.Merge()
    $labelCell = $labelRange.Cells.Item(1, 1)
    $valueCell = $valueRange.Cells.Item(1, 1)
    $labelCell.Value2 = $Label
    $labelCell.Font.Color = $cMuted
    $labelCell.Font.Size = 8
    $labelCell.Font.Bold = $true
    $valueCell.FormulaLocal = $Formula
    $valueCell.NumberFormatLocal = $currencyZeroFormat
    $valueCell.Font.Size = 13
    $valueCell.Font.Bold = $true
    $valueCell.Font.Color = $cWhite
    $valueCell.HorizontalAlignment = -4108
    $valueCell.VerticalAlignment = -4108
    $range.Cells.Item(3, 1).Interior.Color = $Accent
  }

  $kasaSheet.Range("A1:N1").Merge()
  $kasaSheet.Range("A2:N2").Merge()
  $kasaSheet.Range("A1").Value2 = "KASA YAPMA ARACI"
  $kasaSheet.Range("A2").Value2 = "Canli DP kasasi, eldeki kasa, borc-kom ve blokeleri tek ekranda premium mutabakat gorunumu"
  $kasaSheet.Range("A1").Font.Size = 22
  $kasaSheet.Range("A1").Font.Bold = $true
  $kasaSheet.Range("A1").Font.Color = $cGold
  $kasaSheet.Range("A2").Font.Color = $cMuted
  $kasaSheet.Range("A1:N2").Interior.Color = $cHeader

  $kasaSheet.Range("M2").FormulaLocal = '=DP_LIVE!I2'
  $kasaSheet.Range("M2:N2").Font.Color = $cBlue
  $kasaSheet.Range("M2:N2").Font.Bold = $true
  $kasaSheet.Range("M2:N2").HorizontalAlignment = -4152

  Set-Card "A4:B6" "ELIMIZDEKI KASA" "=SUM(B12:B15)" $cGreenFill $cGreen
  Set-Card "C4:D6" "PANEL KASA" "=D10" $cRedFill $cRed
  Set-Card "E4:F6" "DUNKU BORC-KOM" "=D19+D20-D16" $cPurpleFill $cGold
  Set-Card "G4:H6" "GIDER" "=D11+D17+D18+D21+D22" $cBlueFill $cBlue
  Set-Card "I4:J6" "KALMASI GEREKEN" "=E5+G5" $cAmberFill $cGold
  Set-Card "K4:L6" "KALAN" "=C5-A5" $cSlateFill $cBlue
  Set-Card "M4:N6" "FARK" "=I5-K5" $cPurpleFill $cRed

  $kasaSheet.Range("A8:H8").Merge()
  $kasaSheet.Range("A8").Value2 = "KASA AKIS MATRISI"
  $kasaSheet.Range("A8").Font.Bold = $true
  $kasaSheet.Range("A8").Font.Color = $cGold
  $kasaSheet.Range("A8:H8").Interior.Color = $cHeader

  $kasaSheet.Range("A9").Value2 = "Aciklama"
  $kasaSheet.Range("B9:C9").Merge()
  $kasaSheet.Range("B9").Value2 = "Gelir"
  $kasaSheet.Range("D9:E9").Merge()
  $kasaSheet.Range("D9").Value2 = "Kasa"
  $kasaSheet.Range("F9:H9").Merge()
  $kasaSheet.Range("F9").Value2 = "Devir - Kom - Giderler"
  $kasaSheet.Range("A9:H9").Font.Bold = $true
  $kasaSheet.Range("A9:H9").Font.Color = $cText
  $kasaSheet.Range("A9:H9").Interior.Color = $cPanel2

  $matrixRows = @(
    @{ Row = 10; Label = "Panel Kasa"; Gelir = "0"; Kasa = "=DP_LIVE!G2"; Devir = "0"; Type = "panel" },
    @{ Row = 11; Label = "Personel Odemesi"; Gelir = "0"; Kasa = "0"; Devir = "=FORMUL!E3"; Type = "gider" },
    @{ Row = 12; Label = "Ares Kasa"; Gelir = '=SUMIF(KASALAR!A:A;"ares";KASALAR!F:F)'; Kasa = "0"; Devir = "0"; Type = "gelir" },
    @{ Row = 13; Label = "Ecem Kasa"; Gelir = '=SUMIF(KASALAR!A:A;"ecem";KASALAR!F:F)'; Kasa = "0"; Devir = "0"; Type = "gelir" },
    @{ Row = 14; Label = "Aslan Kasa"; Gelir = '=SUMIF(KASALAR!A:A;"aslan";KASALAR!F:F)'; Kasa = "0"; Devir = "0"; Type = "gelir" },
    @{ Row = 15; Label = "Atlas Kasa"; Gelir = '=SUMIF(KASALAR!A:A;"atlas";KASALAR!F:F)'; Kasa = "0"; Devir = "0"; Type = "gelir" },
    @{ Row = 16; Label = "Komisyon Tutari"; Gelir = "0"; Kasa = "0"; Devir = "=DP_LIVE!F2"; Type = "kom" },
    @{ Row = 17; Label = "Set Odemesi Tutari"; Gelir = "0"; Kasa = "0"; Devir = "=FORMUL!E9"; Type = "gider" },
    @{ Row = 18; Label = "Bloke Tutari"; Gelir = "0"; Kasa = "0"; Devir = "=SUM(BLOKELER!B:B)"; Type = "gider" },
    @{ Row = 19; Label = "Dunun Borcu"; Gelir = "0"; Kasa = "0"; Devir = "=FORMUL!E11"; Type = "borc" },
    @{ Row = 20; Label = "Dunun Alacagi"; Gelir = "0"; Kasa = "0"; Devir = "=FORMUL!E12"; Type = "alacak" },
    @{ Row = 21; Label = "Elif Abla Odeme"; Gelir = "0"; Kasa = "0"; Devir = "=FORMUL!E13"; Type = "gider" },
    @{ Row = 22; Label = "Cemal Abi Odeme"; Gelir = "0"; Kasa = "0"; Devir = "=FORMUL!E14"; Type = "gider" }
  )

  foreach ($item in $matrixRows) {
    $row = $item.Row
    $kasaSheet.Range("A$row").Value2 = $item.Label
    $kasaSheet.Range("B$row:C$row").Merge()
    $kasaSheet.Range("D$row:E$row").Merge()
    $kasaSheet.Range("F$row:H$row").Merge()
    $kasaSheet.Range("B$row").FormulaLocal = $item.Gelir
    $kasaSheet.Range("D$row").FormulaLocal = $item.Kasa
    $kasaSheet.Range("F$row").FormulaLocal = $item.Devir
    $kasaSheet.Range("B$row:H$row").NumberFormatLocal = $currencyZeroFormat
    $kasaSheet.Range("B$row").NumberFormatLocal = $currencyZeroFormat
    $kasaSheet.Range("D$row").NumberFormatLocal = $currencyZeroFormat
    $kasaSheet.Range("F$row").NumberFormatLocal = $currencyZeroFormat
    $kasaSheet.Range("A$row:H$row").Font.Bold = $true
    $kasaSheet.Range("A$row:H$row").Interior.Color = $cPanel
    $kasaSheet.Range("A$row").Interior.Color = $cSlateFill
    $kasaSheet.Range("B$row:C$row").Interior.Color = $cGreenFill
    $kasaSheet.Range("D$row:E$row").Interior.Color = $cRedFill
    $kasaSheet.Range("F$row:H$row").Interior.Color = $cBlueFill
    if ($item.Type -eq "borc") {
      $kasaSheet.Range("A$row").Interior.Color = (Xl-Color "#621A22")
      $kasaSheet.Range("F$row:H$row").Interior.Color = (Xl-Color "#4C1A22")
    }
    if ($item.Type -eq "alacak") {
      $kasaSheet.Range("A$row").Interior.Color = (Xl-Color "#5A450D")
      $kasaSheet.Range("F$row:H$row").Interior.Color = (Xl-Color "#4B3E16")
    }
  }
  Set-PremiumBorder $kasaSheet.Range("A9:H22") $cBorder
  $kasaSheet.Range("B10:H22").HorizontalAlignment = -4152

  $kasaSheet.Range("J8:N8").Merge()
  $kasaSheet.Range("J8").Value2 = "GUNCEL BLOKE HESAP TUTARLARI"
  $kasaSheet.Range("J8:N8").Interior.Color = $cHeader
  $kasaSheet.Range("J8:N8").Font.Color = $cGold
  $kasaSheet.Range("J8:N8").Font.Bold = $true
  $kasaSheet.Range("J8:N8").HorizontalAlignment = -4108
  for ($i = 0; $i -lt 8; $i++) {
    $row = 10 + $i
    $srcRow = 2 + $i
    $kasaSheet.Range("J$row:L$row").Merge()
    $kasaSheet.Range("M$row:N$row").Merge()
    $kasaSheet.Range("J$row").FormulaLocal = "=BLOKELER!A$srcRow"
    $kasaSheet.Range("M$row").FormulaLocal = "=BLOKELER!B$srcRow"
    $kasaSheet.Range("M$row").NumberFormatLocal = $currencyZeroFormat
    $kasaSheet.Range("J$row:N$row").Interior.Color = $cPanel
    $kasaSheet.Range("J$row").Font.Color = $cGold
    $kasaSheet.Range("J$row:N$row").Font.Bold = $true
  }
  $kasaSheet.Range("J19:L19").Merge()
  $kasaSheet.Range("M19:N19").Merge()
  $kasaSheet.Range("J19").Value2 = "TOPLAM BLOKE TUTARI"
  $kasaSheet.Range("M19").FormulaLocal = "=SUM(BLOKELER!B:B)"
  $kasaSheet.Range("M19").NumberFormatLocal = $currencyZeroFormat
  $kasaSheet.Range("J19:N19").Interior.Color = $cAmberFill
  $kasaSheet.Range("J19:N19").Font.Color = $cWhite
  $kasaSheet.Range("J19:N19").Font.Bold = $true
  Set-PremiumBorder $kasaSheet.Range("J8:N19") $cBorder

  $kasaSheet.Range("A25:N25").Interior.Color = $cLightHeader
  $kasaSheet.Range("A26:N26").Interior.Color = $cLight
  $kasaSheet.Range("A25:N26").Font.Color = $cDarkText
  $kasaSheet.Range("A25:N26").Font.Bold = $true
  $bottomLabels = @("ELIMIZDEKI KASA", "KASA", "DUNKU BORC-KOM", "GIDER", "KALMASI GEREKEN", "KALAN", "FARK")
  $bottomFormulas = @("=A5", "=C5", "=E5", "=G5", "=I5", "=K5", "=M5")
  for ($i = 0; $i -lt 7; $i++) {
    $firstCol = 1 + ($i * 2)
    $secondCol = $firstCol + 1
    $kasaSheet.Range($kasaSheet.Cells.Item(25, $firstCol), $kasaSheet.Cells.Item(25, $secondCol)).Merge()
    $kasaSheet.Range($kasaSheet.Cells.Item(26, $firstCol), $kasaSheet.Cells.Item(26, $secondCol)).Merge()
    $kasaSheet.Cells.Item(25, $firstCol).Value2 = $bottomLabels[$i]
    $kasaSheet.Cells.Item(26, $firstCol).FormulaLocal = $bottomFormulas[$i]
    $kasaSheet.Cells.Item(26, $firstCol).NumberFormatLocal = $currencyZeroFormat
    if ($i -eq 6) {
      $kasaSheet.Cells.Item(26, $firstCol).Font.Color = (Xl-Color "#047857")
    }
  }
  Set-PremiumBorder $kasaSheet.Range("A25:N26") (Xl-Color "#94A3B8")

  $kasaSheet.Range("A28:N32").Merge()
  $kasaSheet.Range("A28").Value2 = "Not: Bu sayfa CSV merkezinden beslenir. Formul ve bloke manuel verileri FORMUL/BLOKELER sekmelerinden gelir; anlik DP degeri DP_LIVE sekmesinden akar."
  $kasaSheet.Range("A28").Font.Color = $cMuted
  $kasaSheet.Range("A28").WrapText = $true
  $kasaSheet.Range("A28:N32").Interior.Color = $cHeader
  Set-PremiumBorder $kasaSheet.Range("A28:N32") $cBorder

  $kasaSheet.Range("A1").Select() | Out-Null

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
