$ErrorActionPreference = "Stop"
$root = "C:\franchise-platform"
$out  = "C:\franchise-backups"
New-Item -ItemType Directory -Force $out | Out-Null

$url = (Select-String -Path "$root\backend\.env" -Pattern '^DATABASE_URL=(.*)$').Matches[0].Groups[1].Value.Trim()
$pgdump = (Get-ChildItem "C:\Program Files\PostgreSQL" -Recurse -Filter pg_dump.exe | Sort-Object FullName -Descending | Select-Object -First 1).FullName
if (-not $pgdump) { throw "pg_dump.exe not found" }

$file = Join-Path $out ("franchise_" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".dump")
& $pgdump --dbname=$url --format=custom --file=$file
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }

Get-ChildItem $out -Filter *.dump | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item
"Backup written: $file (" + [math]::Round((Get-Item $file).Length / 1KB) + " KB)"