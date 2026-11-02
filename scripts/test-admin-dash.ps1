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

Write-Host "== Overview"
Check "super agent cannot open the admin dashboard" (-not (Api Get "/admin/dashboard" $null $S).ok)
$d = Api Get "/admin/dashboard" $null $A
Check "dashboard loads" $d.ok $d.error
Check "GGR equals volume minus wins" ($d.data.ggr_minor -eq ($d.data.turnover_minor - $d.data.wins_minor))
Check "every game type is listed" (@($d.data.verticals).Count -ge 5)
Check "network counts are numbers" (($d.data.network.super_agents -ge 1) -and ($d.data.network.players -ge 1))
Check "royalty figures are present" (($null -ne $d.data.royalty.betting_minor) -and ($null -ne $d.data.royalty.deposit_minor))
Check "the super agent table lists Vortex" (@($d.data.supers | Where-Object { $_.name -match "Vortex" }).Count -ge 1)
Check "latest ledger operations are listed" (@($d.data.ledger).Count -ge 1)
Check "aggregator URLs are given" (($d.data.api.games_url -match "^http") -and ($d.data.api.wallet_url -match "wallet"))

Write-Host "== Transactions and Requests"
$ops = Api Get "/admin/ledger-ops?limit=50" $null $A
Check "ledger log loads with sender and receiver" ($ops.ok -and @($ops.data).Count -ge 1 -and ($null -ne @($ops.data)[0].amount_minor))
Check "ledger log honours the limit" (@((Api Get "/admin/ledger-ops?limit=3" $null $A).data).Count -le 3)
$cl = Api Get "/admin/cashier-log" $null $A
Check "cashier audit log loads" $cl.ok $cl.error
Check "rows show player, type and a status" ((@($cl.data).Count -eq 0) -or ((@($cl.data)[0].player) -and (@($cl.data)[0].status)))
Check "super agent cannot read the cashier log" (-not (Api Get "/admin/cashier-log" $null $S).ok)

Write-Host "== Agents"
$dir = Api Get "/admin/directory" $null $A
Check "directory lists supers, clubs and players" ($dir.ok -and (@($dir.data | Where-Object { $_.role -eq "super" }).Count -ge 1) -and (@($dir.data | Where-Object { $_.role -eq "player" }).Count -ge 1))
Check "directory shows phone numbers and rates" ((@($dir.data | Where-Object { $_.role -eq "super" -and $_.phone -and $null -ne $_.dep_bps }).Count -ge 1))
$ph = "09" + (Get-Random -Minimum 10000000 -Maximum 99999999)
$body = @{ phone = $ph; display_name = "Dash Super"; password = "Super#Test2026x"; cbe_account = "1000999900001"; deposit_rate_bps = 400; withdrawal_rate_bps = 300; initial_points_minor = 100000 }
$mk = Api Post "/admin/provision-super" $body $A
Check "admin provisions a super agent in one step" $mk.ok $mk.error
$row = @((Api Get "/admin/directory" $null $A).data | Where-Object { $_.id -eq $mk.data.id })[0]
Check "starting points were allocated" ($row.balance_minor -eq 100000) ("balance " + $row.balance_minor)
Check "rates were saved" (($row.dep_bps -eq 400) -and ($row.wd_bps -eq 300))
Check "the CBE account was saved" ($row.cbe_account -eq "1000999900001")
Check "the new super agent can sign in with the phone" ((Api Post "/auth/login" @{ phone = $ph; password = "Super#Test2026x" }).ok)
Check "the same phone again is refused" (-not (Api Post "/admin/provision-super" $body $A).ok)
$b2 = $body.Clone(); $b2.phone = "09" + (Get-Random -Minimum 10000000 -Maximum 99999999); $b2.deposit_rate_bps = 2500
Check "a rate above 20% is refused" (-not (Api Post "/admin/provision-super" $b2 $A).ok)
$b3 = $body.Clone(); $b3.phone = "09" + (Get-Random -Minimum 10000000 -Maximum 99999999); $b3.password = "abc"
Check "a weak password is refused" (-not (Api Post "/admin/provision-super" $b3 $A).ok)
Check "a super agent cannot provision another super agent" (-not (Api Post "/admin/provision-super" $b3 $S).ok)
Check "rates can be changed from the manage panel" ((Api Put "/admin/rates" @{ user_id = $mk.data.id; event_type = "deposit"; rate_bps = 350; cap_bps = 400 } $A).ok)
Check "a new account can be frozen" ((Api Post "/admin/users/$($mk.data.id)/status" @{ status = "frozen" } $A).ok)
Check "...and a frozen account cannot sign in" (-not (Api Post "/auth/login" @{ phone = $ph; password = "Super#Test2026x" }).ok)
$null = Api Post "/admin/users/$($mk.data.id)/status" @{ status = "active" } $A

Write-Host "== Providers"
$pv = Api Get "/admin/providers" $null $A
Check "providers list loads" ($pv.ok -and @($pv.data).Count -ge 6)
$pp = @($pv.data | Where-Object { $_.name -eq "Pragmatic Play" })[0]
$before = @((Api Get "/games").data | Where-Object { $_.provider -eq "Pragmatic Play" }).Count
Check "Pragmatic Play has games in the lobby" ($before -ge 1) "count $before"
Check "admin disables a provider" ((Api Post "/admin/providers/$($pp.id)/status" @{ status = "disabled" } $A).ok)
Check "its games vanish from the player lobby" (@((Api Get "/games").data | Where-Object { $_.provider -eq "Pragmatic Play" }).Count -eq 0)
Check "re-enabling brings them back" (((Api Post "/admin/providers/$($pp.id)/status" @{ status = "active" } $A).ok) -and (@((Api Get "/games").data | Where-Object { $_.provider -eq "Pragmatic Play" }).Count -eq $before))
Check "a fee can be edited" ((Api Put "/admin/providers/$($pp.id)" @{ fee_bps = 1400 } $A).ok)
Check "a fee over 50% is refused" (-not (Api Put "/admin/providers/$($pp.id)" @{ fee_bps = 9000 } $A).ok)
Check "a non-https address is refused" (-not (Api Put "/admin/providers/$($pp.id)" @{ api_endpoint = "http://example.com" } $A).ok)
Check "a private network address is refused" (-not (Api Put "/admin/providers/$($pp.id)" @{ api_endpoint = "https://192.168.1.5/x" } $A).ok)
$null = Api Put "/admin/providers/$($pp.id)" @{ fee_bps = 1500 } $A
$ping = Api Post "/admin/providers/$($pp.id)/ping" $null $A
Check "ping answers (a latency or 'unreachable')" ($ping.ok -and ($null -ne $ping.data.reachable)) $ping.error
Check "a super agent cannot change providers" (-not (Api Post "/admin/providers/$($pp.id)/status" @{ status = "disabled" } $S).ok)

Write-Host "== Aggregator secret"
Check "wrong password does not reveal it" (-not (Api Post "/admin/aggregator-secret" @{ password = "not-my-password" } $A).ok)
$sec = Api Post "/admin/aggregator-secret" @{ password = $DemoPass } $A
Check "the right password reveals it" ($sec.ok -and $sec.data.secret.Length -ge 16) $sec.error
Check "a super agent cannot reveal it" (-not (Api Post "/admin/aggregator-secret" @{ password = $DemoPass } $S).ok)
$au = ((Api Get "/admin/audit" $null $A).data | ConvertTo-Json -Depth 4)
Check "the reveal is in the audit log (without the secret)" (($au -match "reveal_aggregator_secret") -and (-not $sec.ok -or $au -notmatch [regex]::Escape($sec.data.secret)))
Check "books balance" ((Api Get "/admin/reconcile" $null $A).data.ok -eq $true)
Write-Host ""
Write-Host ("==== RESULT: " + $script:passed + " passed, " + $script:failed + " failed ====") -ForegroundColor $(if ($script:failed -eq 0) { "Green" } else { "Red" })
exit $script:failed