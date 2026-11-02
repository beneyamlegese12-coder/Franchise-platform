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
    $key = $(if ($u -match "^[+0-9]") { "phone" } else { "username" })
    $r = Api Post "/auth/login" @{ $key = $u; password = $p }
    if ($r.ok) { return $r.data.token }
    if ($r.status -ne 429) { throw ("Cannot log in as " + $u + ": " + $r.error) }
    Start-Sleep 12
  }
}
$A = Tok "nexus_admin" $DemoPass
$S = Tok "vortex_elite" $DemoPass
$C0 = Tok "club_alpha" $DemoPass
$superId = [int](@((Api Get "/admin/users" $null $A).data | Where-Object { $_.username -eq "vortex_elite" })[0].id)
function SupBal() { (Api Get "/overview" $null $S).data.credit_balance_minor }

Write-Host "== Admin and super agents"
$list = Api Get "/network/agents" $null $A
Check "admin sees super agents with phone and balance" ($list.ok -and @($list.data | Where-Object { $_.id -eq $superId }).Count -eq 1)
$b = SupBal
$r = Api Post "/network/fund" @{ user_id = $superId; amount_minor = 500000; note = "test top-up" } $A
Check "admin tops up a super agent" $r.ok $r.error
Check "the super agent's balance rose by 5000.00" ((SupBal) -eq ($b + 500000))
$r = Api Post "/network/clawback" @{ user_id = $superId; amount_minor = 200000; note = "test clawback" } $A
Check "admin takes some back" $r.ok $r.error
Check "balance fell by 2000.00" ((SupBal) -eq ($b + 300000))
Check "clawing back more than they hold is refused" (-not (Api Post "/network/clawback" @{ user_id = $superId; amount_minor = 90000000000; note = "too much" } $A).ok)
Check "a zero or tiny amount is refused" (-not (Api Post "/network/fund" @{ user_id = $superId; amount_minor = 50 } $A).ok)
Check "admin cannot fund a club agent directly" (-not (Api Post "/network/fund" @{ user_id = 3; amount_minor = 10000 } $A).ok)

Write-Host "== Super agent and clubs"
$ph = "0" + "9" + (Get-Random -Minimum 10000000 -Maximum 99999999)
$mk = Api Post "/network/clubs" @{ phone = $ph; display_name = "Net Club"; password = "Club#Test2026x" } $S
Check "super agent registers a club agent" $mk.ok $mk.error
Check "same phone again is refused" (-not (Api Post "/network/clubs" @{ phone = $ph; display_name = "Dup"; password = "Club#Test2026x" } $S).ok)
Check "weak password is refused" (-not (Api Post "/network/clubs" @{ phone = "0911" + (Get-Random -Minimum 100000 -Maximum 999999); display_name = "Weak"; password = "abc" } $S).ok)
Check "bad phone is refused" (-not (Api Post "/network/clubs" @{ phone = "nope"; display_name = "Bad"; password = "Club#Test2026x" } $S).ok)
$clubId = [int]$mk.data.id
$mine = Api Get "/network/agents" $null $S
Check "the new club appears in the super agent's list" (@($mine.data | Where-Object { $_.id -eq $clubId }).Count -eq 1)
Check "the club agent can sign in with that phone" ((Api Post "/auth/login" @{ phone = $ph; password = "Club#Test2026x" }).ok)
$sb = SupBal
$r = Api Post "/network/fund" @{ user_id = $clubId; amount_minor = 100000; note = "float" } $S
Check "super agent tops up their club" $r.ok $r.error
Check "super agent's balance fell by 1000.00" ((SupBal) -eq ($sb - 100000))
$r = Api Post "/network/clawback" @{ user_id = $clubId; amount_minor = 40000 } $S
Check "super agent takes 400.00 back" $r.ok $r.error
Check "balance is up by 400.00 from there" ((SupBal) -eq ($sb - 60000))
Check "taking back more than the club holds is refused" (-not (Api Post "/network/clawback" @{ user_id = $clubId; amount_minor = 99999999 } $S).ok)
Check "a super agent cannot fund someone else's club" (-not (Api Post "/network/fund" @{ user_id = 99999999; amount_minor = 10000 } $S).ok)
Check "a super agent cannot fund themselves" (-not (Api Post "/network/fund" @{ user_id = $superId; amount_minor = 10000 } $S).ok)
Check "a club agent cannot use these routes" (-not (Api Post "/network/fund" @{ user_id = $clubId; amount_minor = 10000 } $C0).ok)
Check "a club agent cannot register clubs" (-not (Api Post "/network/clubs" @{ phone = "0912121212"; display_name = "No"; password = "Club#Test2026x" } $C0).ok)
$null = Api Post "/admin/users/$clubId/status" @{ status = "frozen" } $A
Check "a frozen club cannot be topped up" (-not (Api Post "/network/fund" @{ user_id = $clubId; amount_minor = 10000 } $S).ok)
Check "...but points can still be taken back from it" ((Api Post "/network/clawback" @{ user_id = $clubId; amount_minor = 10000 } $S).ok)
$null = Api Post "/admin/users/$clubId/status" @{ status = "active" } $A
Check "books balance" ((Api Get "/admin/reconcile" $null $A).data.ok -eq $true)
Check "audit log records the transfers" ((((Api Get "/admin/audit" $null $A).data | ConvertTo-Json -Depth 4) -match "fund_agent") -and (((Api Get "/admin/audit" $null $A).data | ConvertTo-Json -Depth 4) -match "clawback_agent"))
Write-Host ""
Write-Host ("==== RESULT: " + $script:passed + " passed, " + $script:failed + " failed ====") -ForegroundColor $(if ($script:failed -eq 0) { "Green" } else { "Red" })
exit $script:failed