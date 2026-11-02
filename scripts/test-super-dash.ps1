param([string]$DemoPass = "Demo#2026pass")
$base = "http://localhost:4000/api/v1"
$script:passed = 0; $script:failed = 0
function Api($method, $path, $body = $null, $token = $null) {
  $h = @{}; if ($token) { $h["Authorization"] = "Bearer $token" }
  try {
    $p = @{ Uri = "$base$path"; Method = $method; Headers = $h; ContentType = "application/json" }
    if ($null -ne $body) { $p["Body"] = ($body | ConvertTo-Json -Depth 6) }
    [pscustomobject]@{ ok = $true; status = 200; data = (Invoke-RestMethod @p); error = "" }
  } catch {
    $code = 0; try { $code = [int]$_.Exception.Response.StatusCode } catch {}
    $err = "$($_.ErrorDetails.Message)"; try { $e2 = ($err | ConvertFrom-Json).error; if ($e2) { $err = $e2 } } catch {}
    [pscustomobject]@{ ok = $false; status = $code; data = $null; error = $err }
  }
}
function Check($name, $cond, $detail = "") {
  if ($cond) { $script:passed++; Write-Host ("  PASS  " + $name) -ForegroundColor Green }
  else { $script:failed++; Write-Host ("  FAIL  " + $name + "   " + $detail) -ForegroundColor Red }
}
function Tok($u, $p) {
  for ($i = 0; $i -lt 6; $i++) {
    $r = Api Post "/auth/login" @{ username = $u; password = $p }
    if ($r.ok) { return $r.data.token }
    if ($r.status -ne 429) { throw ("Cannot log in as " + $u + ": " + $r.error) }
    Start-Sleep 12
  }
}
$A = Tok "nexus_admin" $DemoPass
$S = Tok "vortex_elite" $DemoPass
$C0 = Tok "club_alpha" $DemoPass
$superId = [int](@((Api Get "/admin/users" $null $A).data | Where-Object { $_.username -eq "vortex_elite" })[0].id)
$null = Api Post "/network/fund" @{ user_id = $superId; amount_minor = 500000; note = "test float" } $A

Write-Host "== Overview data"
Check "a club agent cannot read it" (-not (Api Get "/super/dashboard" $null $C0).ok)
Check "admin cannot read it" (-not (Api Get "/super/dashboard" $null $A).ok)
$d = Api Get "/super/dashboard" $null $S
Check "dashboard loads" $d.ok $d.error
Check "balance matches the wallet" ($d.data.balance_minor -eq (Api Get "/overview" $null $S).data.credit_balance_minor)
Check "the upstream node is named" ($d.data.upstream.Length -gt 0)
Check "own rates are returned" (($null -ne $d.data.rates.dep_bps) -and ($null -ne $d.data.rates.wd_bps))
Check "commission figures are numbers" (($null -ne $d.data.commission.deposit_minor) -and ($null -ne $d.data.commission.withdrawal_minor))
Check "the club directory has phone, rates and balance" ((@($d.data.clubs).Count -eq 0) -or ((@($d.data.clubs)[0].phone) -and ($null -ne @($d.data.clubs)[0].dep_bps)))
Check "the directory only lists this super agent's clubs" ((@($d.data.clubs).Count -eq 0) -or (@($d.data.clubs | Where-Object { $_.name -match "Zzz" }).Count -eq 0))

Write-Host "== Register a club with rates and a starting top-up"
$myDep = [int]$d.data.rates.dep_bps; $myWd = [int]$d.data.rates.wd_bps
$ph = "09" + (Get-Random -Minimum 10000000 -Maximum 99999999)
$before = (Api Get "/overview" $null $S).data.credit_balance_minor
$body = @{ phone = $ph; display_name = "Super Made Club"; password = "Club#Test2026x"; cbe_account = "1000777700001"; deposit_rate_bps = $myDep; withdrawal_rate_bps = $myWd; initial_points_minor = 120000 }
$mk = Api Post "/network/clubs" $body $S
Check "super agent registers a club" $mk.ok $mk.error
$dd = (Api Get "/super/dashboard" $null $S).data
$row = @($dd.clubs | Where-Object { $_.id -eq $mk.data.id })[0]
Check "the club appears in the directory" ($null -ne $row)
Check "the CBE account was saved" ($row.cbe_account -eq "1000777700001")
Check "rates were saved at the allowed maximum" (($row.dep_bps -eq $myDep) -and ($row.wd_bps -eq $myWd))
Check "the starting top-up reached the club" ($row.balance_minor -eq 120000) ("balance " + $row.balance_minor)
Check "it came out of the super agent's balance" (($before - $dd.balance_minor) -eq 120000)
Check "the club can sign in with that phone" ((Api Post "/auth/login" @{ phone = $ph; password = "Club#Test2026x" }).ok)
$b2 = $body.Clone(); $b2.phone = "09" + (Get-Random -Minimum 10000000 -Maximum 99999999); $b2.deposit_rate_bps = $myDep + 25
Check "a rate above the super agent's own is refused" (-not (Api Post "/network/clubs" $b2 $S).ok)
$b3 = $body.Clone(); $b3.phone = "09" + (Get-Random -Minimum 10000000 -Maximum 99999999); $b3.initial_points_minor = 90000000000
Check "a top-up bigger than the balance is refused" (-not (Api Post "/network/clubs" $b3 $S).ok)
Check "...and no half-created club is left behind" (@((Api Get "/network/agents" $null $S).data | Where-Object { $_.phone -match $b3.phone.Substring(1) }).Count -eq 0)
Check "the same phone twice is refused" (-not (Api Post "/network/clubs" $body $S).ok)

Write-Host "== Ledger and requests"
$lg = Api Get "/super/ledger?limit=20" $null $S
Check "ledger loads" ($lg.ok -and @($lg.data).Count -ge 1) $lg.error
Check "it includes the initial top-up" (@($lg.data | Where-Object { $_.memo -match "Initial top-up for Super Made Club" }).Count -ge 1)
Check "the limit is honoured" (@((Api Get "/super/ledger?limit=2" $null $S).data).Count -le 2)
Check "a club agent cannot read it" (-not (Api Get "/super/ledger" $null $C0).ok)
$dr = Api Get "/super/downline-requests" $null $S
Check "downline requests load" $dr.ok $dr.error
Check "each row names a club" ((@($dr.data).Count -eq 0) -or ((@($dr.data | Where-Object { -not $_.club }).Count -eq 0)))
Check "a club agent cannot read downline requests" (-not (Api Get "/super/downline-requests" $null $C0).ok)
Check "books balance" ((Api Get "/admin/reconcile" $null $A).data.ok -eq $true)
Write-Host ""
Write-Host ("==== RESULT: " + $script:passed + " passed, " + $script:failed + " failed ====") -ForegroundColor $(if ($script:failed -eq 0) { "Green" } else { "Red" })
exit $script:failed