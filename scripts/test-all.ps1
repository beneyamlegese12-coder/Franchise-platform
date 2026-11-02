param([switch]$SkipSettlement, [switch]$SkipBackup, [string]$DemoPass = "Demo#2026pass")
$base = "http://localhost:4000/api/v1"
$root = Split-Path $PSScriptRoot -Parent
$staffSite  = @{ Origin = "http://localhost:5174" }
$playerSite = @{ Origin = "http://localhost:5173" }
$rand = Get-Random -Minimum 10000 -Maximum 99999
$script:passed = 0; $script:failed = 0; $script:failures = @(); $script:warnings = @()
$pw = "Welcome!Mika2026x"; $clubPw = "Club#Test2026x"

function Ph($n) { "+2519" + ("{0:D8}" -f ((([int]$rand * 1000) + $n) % 100000000)) }$method, $path, $body = $null, $token = $null, $headers = @{}) {
  $h = @{}
  foreach ($k in $headers.Keys) { $h[$k] = $headers[$k] }
  if ($token) { $h["Authorization"] = "Bearer $token" }
  try {
    $p = @{ Uri = "$base$path"; Method = $method; Headers = $h; ContentType = "application/json" }
    if ($null -ne $body) { $p["Body"] = ($body | ConvertTo-Json -Depth 6) }
    $r = Invoke-RestMethod @p
    [pscustomobject]@{ ok = $true; status = 200; data = $r; error = "" }
  } catch {
    $code = 0
    try { $code = [int]$_.Exception.Response.StatusCode } catch {}
    $err = "$($_.ErrorDetails.Message)"
    try { $e2 = ($err | ConvertFrom-Json).error; if ($e2) { $err = $e2 } } catch {}
    [pscustomobject]@{ ok = $false; status = $code; data = $null; error = $err }
  }
}
function Check($name, $cond, $detail = "") {
  if ($cond) { $script:passed++; Write-Host ("  PASS  " + $name) -ForegroundColor Green }
  else { $script:failed++; $script:failures += ($name + "  " + $detail); Write-Host ("  FAIL  " + $name + "   " + $detail) -ForegroundColor Red }
}
function Warn($t) { $script:warnings += $t; Write-Host ("  WARN  " + $t) -ForegroundColor Yellow }
function Section($t) { Write-Host ""; Write-Host ("== " + $t) -ForegroundColor Cyan }
function Login($u, $p, $hdr = @{}) {
  for ($i = 0; $i -lt 6; $i++) {
    $key = $(if ($u -match "^[+0-9]") { "phone" } else { "username" }); $r = Api Post "/auth/login" @{ $key = $u; password = $p } $null $hdr
    if ($r.status -ne 429 -or $r.error -match "failed attempts") { return $r }
    Start-Sleep 12
  }
  return $r
}
function Tok($u, $p, $hdr = @{}) {
  $r = Login $u $p $hdr
  if (-not $r.ok) { throw ("Cannot log in as " + $u + ": " + $r.error) }
  return $r.data.token
}
function Register($u, $dob = "1995-04-12") {
  Api Post "/auth/register" @{ phone = $u; display_name = ("Test " + $u); password = $pw; date_of_birth = $dob } $null $playerSite
}
function Recon($when) { $r = Api Get "/admin/reconcile" $null $A; Check ("books balance " + $when) ($r.ok -and $r.data.ok -eq $true) $r.error }
function Bal($t) { (Api Get "/player/overview" $null $t).data.credit_balance_minor }
function ClubOv($t) { (Api Get "/club/overview" $null $t).data }
function SupBal() { (Api Get "/overview" $null $S).data.credit_balance_minor }

# Whole deposit: request, claim, reference, approve
function DoDeposit($pt, $ct, $amount, $approve = $true) {
  $r = Api Post "/requests/deposit" @{ amount_minor = $amount; channel = "CBE"; phone = "+251900000001" } $pt
  if (-not $r.ok) { return [pscustomobject]@{ ok = $false; id = 0; error = $r.error } }
  $id = $r.data.id
  $c = Api Post "/queue/$id/claim" $null $ct
  if (-not $c.ok) { return [pscustomobject]@{ ok = $false; id = $id; error = ("claim: " + $c.error) } }
  $f = Api Post "/requests/$id/reference" @{ reference = "R$id-$rand" } $pt
  if (-not $f.ok) { return [pscustomobject]@{ ok = $false; id = $id; error = ("reference: " + $f.error) } }
  if ($approve) {
    $a = Api Post "/point-requests/$id/approve" $null $ct
    Start-Sleep -Milliseconds 600
    return [pscustomobject]@{ ok = $a.ok; id = $id; error = $a.error }
  }
  return [pscustomobject]@{ ok = $true; id = $id; error = "" }
}
function DoWithdraw($pt, $ct, $amount) {
  $r = Api Post "/requests/withdraw" @{ amount_minor = $amount; channel = "CBE"; phone = "+251900000001"; account_no = "1000123412341" } $pt
  if (-not $r.ok) { return [pscustomobject]@{ ok = $false; id = 0; error = $r.error } }
  $id = $r.data.id
  $c = Api Post "/queue/$id/claim" $null $ct
  if (-not $c.ok) { return [pscustomobject]@{ ok = $false; id = $id; error = ("claim: " + $c.error) } }
  $a = Api Post "/point-requests/$id/approve" $null $ct
  Start-Sleep -Milliseconds 600
  return [pscustomobject]@{ ok = $a.ok; id = $id; error = $a.error }
}

try {

Section "1. Everything is running"
$h = Api Get "/health"
Check "backend answers and reaches the database" ($h.ok -and $h.data.status -eq "ok") $h.error
try { $w = Invoke-WebRequest "$base/health" -UseBasicParsing; Check "security headers are on" ($w.Headers["X-Content-Type-Options"] -eq "nosniff") }
catch { Check "security headers are on" $false $_.Exception.Message }
foreach ($site in @(@("player site 5173", "http://localhost:5173"), @("staff site 5174", "http://localhost:5174"))) {
  try { $w = Invoke-WebRequest $site[1] -UseBasicParsing -TimeoutSec 8; Check ($site[0] + " loads") ($w.StatusCode -eq 200) }
  catch { Check ($site[0] + " loads") $false $_.Exception.Message }
  try { $w = Invoke-RestMethod ($site[1] + "/api/v1/health") -TimeoutSec 8; Check ($site[0] + " reaches the backend") ($w.status -eq "ok") }
  catch { Check ($site[0] + " reaches the backend") $false $_.Exception.Message }
}

Section "2. Login security"
$lockU = Ph 1
$null = Register $lockU
for ($i = 1; $i -le 5; $i++) { $null = Login $lockU ("WrongPass#" + $i) }
$r = Login $lockU $pw
Check "5 wrong passwords lock the account" ((-not $r.ok) -and $r.error -match "failed attempts") ("status " + $r.status + ": " + $r.error)
$r = Login "nexus_admin" "not-the-password"
Check "wrong password is refused" ((-not $r.ok) -and $r.status -eq 401) ("status " + $r.status)
$r = Api Get "/admin/overview"
Check "no token, no access" ((-not $r.ok) -and $r.status -eq 401)
$A  = Tok "nexus_admin" $DemoPass
$S  = Tok "vortex_elite" $DemoPass
$C0 = Tok "club_alpha" $DemoPass
$r = Api Post "/admin/users/1/reset-password" @{ new_password = "abc" } $A
Check "weak password is refused by the policy" (-not $r.ok) $r.error

Section "3. Public player site and registration"
$g = Api Get "/games"
Check "games list needs no login" ($g.ok -and @($g.data).Count -ge 10) ("count " + @($g.data).Count)
$gid = @($g.data)[0].id
$r = Api Post "/games/$gid/launch"
Check "launching a game needs a login" ((-not $r.ok) -and $r.status -eq 401)
$p1 = Ph 2
$reg = Register $p1
Check "player can register" ($reg.ok -and $reg.data.user.role -eq "player") $reg.error
$P1 = $reg.data.token; $p1Id = [int]$reg.data.user.id
Check "duplicate username is refused" (-not (Register $p1).ok)
Check "under-18 is refused" (-not (Register (Ph 3) "2015-01-01").ok)
$r = Api Post "/auth/register" @{ phone = (Ph 4); display_name = "Weak"; password = "abc"; date_of_birth = "1990-01-01" } $null $playerSite
Check "weak password is refused at registration" (-not $r.ok)
$r = Api Post "/auth/register" @{ phone = "abc"; display_name = "Bad"; password = $pw; date_of_birth = "1990-01-01" } $null $playerSite
Check "invalid username is refused" (-not $r.ok)
$r = Login $p1 $pw $staffSite
Check "player is refused on the staff site" (-not $r.ok) $r.error
$r = Login "nexus_admin" $DemoPass $playerSite
Check "admin is refused on the player site" (-not $r.ok) $r.error
$rs = Login $p1 $pw $playerSite; Check "player can sign in on the player site" $rs.ok ("status " + $rs.status + ": " + $rs.error)

Section "4. Roles and permissions"
Check "player cannot open the admin overview" (-not (Api Get "/admin/overview" $null $P1).ok)
Check "club agent cannot mint points" (-not (Api Post "/admin/mint" @{ user_id = 1; amount_minor = 100; reason = "should fail" } $C0).ok)
Check "super agent cannot open the admin audit" (-not (Api Get "/admin/audit" $null $S).ok)
Check "player cannot open the club overview" (-not (Api Get "/club/overview" $null $P1).ok)

Section "5. Admin: users, rates, freezing"
$users = (Api Get "/admin/users" $null $A).data
$superId = [int](@($users | Where-Object { $_.username -eq "vortex_elite" })[0].id)
$clubU = Ph 5
$newClub = @{ role = "club"; parent_id = $superId; phone = $clubU; display_name = "Test Club $rand"; password = $clubPw; deposit_rate_bps = 500; withdrawal_rate_bps = 100 }
$mk = Api Post "/admin/users" $newClub $A
Check "admin creates a club agent" $mk.ok $mk.error
Check "duplicate club username is refused" (-not (Api Post "/admin/users" $newClub $A).ok)
$clubId = [int](@((Api Get "/admin/users" $null $A).data | Where-Object { $_.username -eq $clubU })[0].id)
$CT = Tok $clubU $clubPw
$null = Api Post "/admin/users/$clubId/status" @{ status = "frozen" } $A
Check "frozen agent cannot log in" (-not (Login $clubU $clubPw).ok)
Check "frozen agent's old login stops working at once" (-not (Api Get "/club/overview" $null $CT).ok)
$null = Api Post "/admin/users/$clubId/status" @{ status = "active" } $A
Check "unfrozen agent works again" ((Api Get "/club/overview" $null $CT).ok)
Check "a rate above its cap is refused" (-not (Api Put "/admin/rates" @{ user_id = $clubId; event_type = "deposit"; rate_bps = 900; cap_bps = 500 } $A).ok)
Check "a valid rate is saved" ((Api Put "/admin/rates" @{ user_id = $clubId; event_type = "deposit"; rate_bps = 500; cap_bps = 500 } $A).ok)
Recon "after creating users"

Section "6. Points between levels (agent to super agent to admin)"
$null = Api Post "/admin/mint" @{ user_id = $superId; amount_minor = 100000; reason = "test float $rand" } $A
$null = Api Put "/my/channels" @{ channel = "CBE"; phone = "+251912345678"; account_no = "1000987654321" } $S
$null = Api Put "/my/channels" @{ channel = "CBE"; phone = "+251900000099"; account_no = "1000555566667" } $A
$null = Api Put "/my/channels" @{ channel = "CBE"; phone = "+251911000001"; account_no = "1000111122223" } $CT
$null = Api Put "/club/channels" @{ channel = "CBE"; phone = "+251911000001"; account_no = "1000111122223" } $CT
$supBefore = SupBal
$a1 = Api Post "/points/asks" @{ type = "deposit"; amount_minor = 50000; note = "test float" } $CT
Check "club agent asks the super agent for points" $a1.ok $a1.error
$id = $a1.data.id
$pool = Api Get "/points/pool" $null $S
Check "super agent sees it in the pool" (@($pool.data.requests | Where-Object { $_.id -eq $id }).Count -eq 1)
Check "pool hides payment details" ((($pool.data | ConvertTo-Json -Depth 6) -notmatch "account_no"))
Check "approve before claiming is refused" (-not (Api Post "/points/asks/$id/approve" $null $S).ok)
Check "admin cannot claim a club agent's request" (-not (Api Post "/points/asks/$id/claim" $null $A).ok)
Check "a club agent cannot claim" (-not (Api Post "/points/asks/$id/claim" $null $CT).ok)
$r = Api Post "/points/asks/$id/claim" $null $S
Check "super agent claims it" $r.ok $r.error
Check "top-up cannot be approved without a reference" (-not (Api Post "/points/asks/$id/approve" $null $S).ok)
$mine = @((Api Get "/points/asks/mine" $null $CT).data | Where-Object { $_.id -eq $id })[0]
Check "club agent sees status CLAIMED and the super agent's account" ($mine.status -eq "CLAIMED" -and $mine.claimer.channels.Count -ge 1)
$ref1 = "TREF$rand"
Check "club agent sends the reference" ((Api Post "/points/asks/$id/reference" @{ reference = $ref1 } $CT).ok)
$r = Api Post "/points/asks/$id/approve" $null $S
Check "super agent approves the top-up" $r.ok $r.error
Check "club agent received 50000 points" ((ClubOv $CT).credit_balance_minor -eq 50000) ("has " + (ClubOv $CT).credit_balance_minor)
Check "super agent's balance dropped by 50000" ((SupBal) -eq ($supBefore - 50000))
$a2 = Api Post "/points/asks" @{ type = "deposit"; amount_minor = 100 } $CT
$id2 = $a2.data.id
$null = Api Post "/points/asks/$id2/claim" $null $S
Check "a transfer reference cannot be used twice" (-not (Api Post "/points/asks/$id2/reference" @{ reference = $ref1 } $CT).ok)
Check "claim can be released" ((Api Post "/points/asks/$id2/release" $null $S).ok)
Check "open request can be cancelled" ((Api Post "/points/asks/$id2/cancel" $null $CT).ok)
$w1 = Api Post "/points/asks" @{ type = "withdrawal"; amount_minor = 10000 } $CT
$null = Api Post "/points/asks/$($w1.data.id)/claim" $null $S
$r = Api Post "/points/asks/$($w1.data.id)/approve" $null $S
Check "withdrawal of points is approved" $r.ok $r.error
Check "club balance is now 40000" ((ClubOv $CT).credit_balance_minor -eq 40000) ("has " + (ClubOv $CT).credit_balance_minor)
Check "withdrawing more points than you have is refused" (-not (Api Post "/points/asks" @{ type = "withdrawal"; amount_minor = 900000000 } $CT).ok)
$tmp = @(); for ($i = 0; $i -lt 3; $i++) { $t = Api Post "/points/asks" @{ type = "deposit"; amount_minor = 100 } $CT; $tmp += $t.data.id }
Check "a 4th open request is refused" (-not (Api Post "/points/asks" @{ type = "deposit"; amount_minor = 100 } $CT).ok)
foreach ($t in $tmp) { $null = Api Post "/points/asks/$t/cancel" $null $CT }
$s1 = Api Post "/points/asks" @{ type = "deposit"; amount_minor = 20000; note = "top up" } $S
Check "super agent asks the admin for points" $s1.ok $s1.error
Check "admin sees it in the pool" (@((Api Get "/points/pool" $null $A).data.requests | Where-Object { $_.id -eq $s1.data.id }).Count -eq 1)
Check "club agent cannot claim at admin level" (-not (Api Post "/points/asks/$($s1.data.id)/claim" $null $CT).ok)
$null = Api Post "/points/asks/$($s1.data.id)/claim" $null $A
$null = Api Post "/points/asks/$($s1.data.id)/reference" @{ reference = "ADM$rand" } $S
$supBefore2 = SupBal
$r = Api Post "/points/asks/$($s1.data.id)/approve" $null $A
Check "admin approves the super agent's top-up" $r.ok $r.error
Check "super agent gained 20000" ((SupBal) -eq ($supBefore2 + 20000))
Recon "after point transfers"

Section "7. Player cashier and the claim queue"
Check "new player starts under the default club" ((Api Get "/player/overview" $null $P1).data.club -ne $null)
$d = Api Post "/requests/deposit" @{ amount_minor = 10000; channel = "CBE"; phone = "+251900000001" } $P1
Check "player sends a deposit request" $d.ok $d.error
$dId = $d.data.id
$qp = Api Get "/queue/pool" $null $CT
Check "it appears in the shared pool" (@($qp.data.requests | Where-Object { $_.id -eq $dId }).Count -eq 1)
Check "the pool hides the player's phone" ((($qp.data | ConvertTo-Json -Depth 6) -notmatch "251900000001"))
Check "approving without claiming is refused" (-not (Api Post "/point-requests/$dId/approve" $null $CT).ok)
Check "agent claims it" ((Api Post "/queue/$dId/claim" $null $CT).ok)
Check "a second agent cannot claim it" (-not (Api Post "/queue/$dId/claim" $null $C0).ok)
$row = @((Api Get "/requests/mine" $null $P1).data | Where-Object { $_.id -eq $dId })[0]
Check "player sees CLAIMED and the agent's phone" ($row.status -eq "CLAIMED" -and $row.agent.phone -eq "+251911000001")
Check "player cannot cancel a claimed request" (-not $row.can_cancel)
Check "player sends the transfer reference" ((Api Post "/requests/$dId/reference" @{ reference = "FT$rand" } $P1).ok)
$cb = ClubOv $CT
$r = Api Post "/point-requests/$dId/approve" $null $CT
Start-Sleep -Milliseconds 700
Check "agent approves the deposit" $r.ok $r.error
Check "player received 10000" ((Bal $P1) -eq 10000) ("has " + (Bal $P1))
$ca = ClubOv $CT
Check "agent's points dropped by 10000" (($cb.credit_balance_minor - $ca.credit_balance_minor) -eq 10000)
$commDeposit = $ca.commission_balance_minor - $cb.commission_balance_minor
Check "player moved under the agent who served them" ((Api Get "/player/overview" $null $P1).data.club -eq ("Test Club " + $rand))

$cb = ClubOv $CT
$wd = DoWithdraw $P1 $CT 4000
Check "withdrawal is claimed and approved" $wd.ok $wd.error
$pv = (Api Get "/player/overview" $null $P1).data
Check "player balance is 6000 and nothing is held" ($pv.credit_balance_minor -eq 6000 -and $pv.held_minor -eq 0) ("bal " + $pv.credit_balance_minor + " held " + $pv.held_minor)
$ca = ClubOv $CT
Check "agent received the 4000 points back" (($ca.credit_balance_minor - $cb.credit_balance_minor) -eq 4000)
$commWithdraw = $ca.commission_balance_minor - $cb.commission_balance_minor
Check "withdrawing more than the balance is refused" (-not (Api Post "/requests/withdraw" @{ amount_minor = 90000000; channel = "CBE"; phone = "+251900000001"; account_no = "1000123412341" } $P1).ok)
$cw = Api Post "/requests/withdraw" @{ amount_minor = 1000; channel = "CBE"; phone = "+251900000001"; account_no = "1000123412341" } $P1
Check "withdrawal puts the amount on hold" ((Bal $P1) -eq 5000)
Check "player cancels an open withdrawal" ((Api Post "/requests/$($cw.data.id)/cancel" $null $P1).ok)
Check "cancelling releases the hold" ((Bal $P1) -eq 6000)
$ids = @(); for ($i = 0; $i -lt 3; $i++) { $t = Api Post "/requests/withdraw" @{ amount_minor = 100; channel = "CBE"; phone = "+251900000001"; account_no = "1000123412341" } $P1; $ids += $t.data.id }
Check "a player cannot have more than 3 open requests" (-not (Api Post "/requests/withdraw" @{ amount_minor = 100; channel = "CBE"; phone = "+251900000001"; account_no = "1000123412341" } $P1).ok)
foreach ($t in $ids) { $null = Api Post "/requests/$t/cancel" $null $P1 }
Check "all holds are released" ((Bal $P1) -eq 6000)
$null = Api Post "/players/$p1Id/status" @{ status = "frozen" } $CT
Check "a frozen player cannot make requests" (-not (Api Post "/requests/deposit" @{ amount_minor = 100; channel = "CBE"; phone = "+251900000001" } $P1).ok)
$null = Api Post "/players/$p1Id/status" @{ status = "active" } $CT
Check "an unfrozen player can again" ((Api Post "/requests/withdraw" @{ amount_minor = 100; channel = "CBE"; phone = "+251900000001"; account_no = "1000123412341" } $P1).ok)
foreach ($x in @((Api Get "/requests/mine" $null $P1).data | Where-Object { $_.can_cancel })) { $null = Api Post "/requests/$($x.id)/cancel" $null $P1 }

$wr = Api Post "/requests/withdraw" @{ amount_minor = 500; channel = "CBE"; phone = "+251900000001"; account_no = "1000123412341" } $P1
$wid = $wr.data.id
$sb = { param($u, $t) try { Invoke-RestMethod $u -Method Post -Headers @{ Authorization = "Bearer $t" } | Out-Null; "OK" } catch { "REFUSED" } }
$j1 = Start-Job -ScriptBlock $sb -ArgumentList "$base/queue/$wid/claim", $CT
$j2 = Start-Job -ScriptBlock $sb -ArgumentList "$base/queue/$wid/claim", $C0
$res = @(Receive-Job -Job $j1, $j2 -Wait -AutoRemoveJob)
Check "of two agents claiming at the same time, exactly one wins" (@($res | Where-Object { $_ -eq "OK" }).Count -eq 1) ($res -join ",")
$null = Api Post "/queue/$wid/release" $null $CT
$null = Api Post "/queue/$wid/release" $null $C0
$null = Api Post "/requests/$wid/cancel" $null $P1
Recon "after the cashier flows"

Section "8. Commissions"
Check "club deposit commission is 5% of 10000 = 500" ($commDeposit -eq 500) ("was " + $commDeposit)
Check "club withdrawal commission is 1% of 4000 = 40" ($commWithdraw -eq 40) ("was " + $commWithdraw)
Check "club ledger has entries" (@((Api Get "/ledger" $null $CT).data).Count -gt 0)
Check "player ledger has entries" (@((Api Get "/ledger" $null $P1).data).Count -gt 0)

Section "9. Reversals (admin only)"
$d2 = DoDeposit $P1 $CT 2000
Check "a small deposit is approved" $d2.ok $d2.error
$cb = ClubOv $CT; $pb = Bal $P1
$r = Api Post "/admin/reversals" @{ point_request_id = [int]$d2.id; reason = "test reversal" } $A
Check "admin reverses it" $r.ok $r.error
Check "player lost the 2000" (($pb - (Bal $P1)) -eq 2000)
Check "agent got the 2000 back" (((ClubOv $CT).credit_balance_minor - $cb.credit_balance_minor) -eq 2000)
Check "the 5% commission was clawed back" (($cb.commission_balance_minor - (ClubOv $CT).commission_balance_minor) -eq 100)
Check "reversing twice is refused" (-not (Api Post "/admin/reversals" @{ point_request_id = [int]$d2.id; reason = "again" } $A).ok)
Check "reversal needs a reason" (-not (Api Post "/admin/reversals" @{ point_request_id = [int]$dId; reason = "x" } $A).ok)
Check "reversing money the player already spent is blocked" (-not (Api Post "/admin/reversals" @{ point_request_id = [int]$dId; reason = "should be blocked" } $A).ok)
Check "club agent cannot reverse" (-not (Api Post "/admin/reversals" @{ point_request_id = [int]$d2.id; reason = "no" } $CT).ok)
Recon "after reversals"

Section "10. Daily settlement"
if ($SkipSettlement) { Warn "settlement skipped" } else {
  $cb = ClubOv $CT
  $un = Api Get "/admin/unsettled" $null $A
  Check "unsettled commission is listed" $un.ok $un.error
  $st = Api Post "/admin/settle" $null $A
  Check "settlement runs" $st.ok $st.error
  Start-Sleep -Milliseconds 500
  $ca = ClubOv $CT
  Check "agent's accrued commission is now zero" ($ca.commission_balance_minor -eq 0) ("is " + $ca.commission_balance_minor)
  Check "it moved into the agent's points" (($ca.credit_balance_minor - $cb.credit_balance_minor) -eq $cb.commission_balance_minor)
  Check "settlement history is available" ((Api Get "/admin/settlements" $null $A).ok)
  Recon "after settlement"
}

Section "11. Games and the game wallet"
$games = (Api Get "/games").data
$ln = Api Post "/games/$gid/launch" $null $P1
Check "player can launch a game" $ln.ok $ln.error
if ($ln.data.demo) { Warn "demo games are ON (fine locally, must be OFF before real money)" }
$bal = Bal $P1; $bal0 = $bal; $why = ""; $okAll = $true
for ($i = 0; $i -lt 5; $i++) {
  $r = Api Post "/games/$gid/demo-round" @{ amount_minor = 100 } $P1
  if (-not $r.ok) { $okAll = $false; $why = $r.error; break }
  $bal = $bal - $r.data.bet_minor + $r.data.win_minor
  if ($r.data.balance_minor -ne $bal) { $okAll = $false; $why = ("round " + $i + ": server says " + $r.data.balance_minor + ", expected " + $bal) }
}
Check "5 demo rounds, balance adds up every time" $okAll ("start " + $bal0 + " - " + $why)
Check "a stake above the balance is refused" (-not (Api Post "/games/$gid/demo-round" @{ amount_minor = 9999999 } $P1).ok)
Check "a game call without a signature is refused" (-not (Api Post "/wallet/bet" @{ player = $p1; tx_id = "x$rand"; amount_minor = 100 }).ok)
Push-Location (Join-Path $root "backend")
$before = Bal $P1
$o1 = (& npm run wallet -- bet player=$p1 tx_id=T$rand amount_minor=100 2>&1 | Out-String)
$o2 = (& npm run wallet -- bet player=$p1 tx_id=T$rand amount_minor=100 2>&1 | Out-String)
$after = Bal $P1
Check "a signed bet is taken once, even if sent twice" (($before - $after) -eq 100) ("balance changed by " + ($before - $after))
$null = (& npm run mock -- 10 2>&1 | Out-String)
Check "mock game provider runs cleanly" ($LASTEXITCODE -eq 0)
Pop-Location
Check "admin games report loads" ((Api Get "/admin/games" $null $A).ok)
Recon "after game play"

Section "12. Responsible gambling"
$p2 = Ph 6; $reg2 = Register $p2; $P2 = $reg2.data.token; $p2Id = [int]$reg2.data.user.id
$f = DoDeposit $P2 $CT 10000
Check "test player is funded" $f.ok $f.error
$r = Api Put "/player/limits" @{ kind = "deposit_day"; amount_minor = 12000 } $P2
Check "player sets a daily deposit limit" ($r.ok -and $r.data.applied -eq $true) $r.error
Check "a deposit over the limit is refused" (-not (Api Post "/requests/deposit" @{ amount_minor = 2500; channel = "CBE"; phone = "+251900000001" } $P2).ok)
$ok15 = Api Post "/requests/deposit" @{ amount_minor = 1500; channel = "CBE"; phone = "+251900000001" } $P2
Check "a deposit within the limit is allowed" $ok15.ok $ok15.error
if ($ok15.ok) { $null = Api Post "/requests/$($ok15.data.id)/cancel" $null $P2 }
$r = Api Put "/player/limits" @{ kind = "deposit_day"; amount_minor = 20000 } $P2
Check "raising a limit waits for the cooling-off period" ($r.ok -and $r.data.applied -eq $false) ("applied: " + $r.data.applied)
$r = Api Put "/player/limits" @{ kind = "deposit_day"; amount_minor = 11000 } $P2
Check "lowering a limit applies immediately" ($r.ok -and $r.data.applied -eq $true) $r.error
$null = Api Put "/player/limits" @{ kind = "loss_day"; amount_minor = 300 } $P2
$blocked = $false; $blockMsg = ""
for ($i = 0; $i -lt 30; $i++) {
  $r = Api Post "/games/$gid/demo-round" @{ amount_minor = 200 } $P2
  if (-not $r.ok) { $blocked = $true; $blockMsg = $r.error; break }
}
Check "the daily loss limit stops play" $blocked "30 rounds without a block"
Check "...with a plain sentence, not a code" ($blockMsg -match "loss limit") $blockMsg

$p3 = Ph 7; $reg3 = Register $p3; $P3 = $reg3.data.token; $p3Id = [int]$reg3.data.user.id
Check "player can self-exclude" ((Api Post "/player/exclude" @{ days = 1 } $P3).ok)
Check "excluded player cannot launch a game" (-not (Api Post "/games/$gid/launch" $null $P3).ok)
Check "excluded player cannot deposit" (-not (Api Post "/requests/deposit" @{ amount_minor = 100; channel = "CBE"; phone = "+251900000001" } $P3).ok)
Check "an invalid exclusion length is refused" (-not (Api Post "/player/exclude" @{ days = 3 } $P3).ok)
Check "a player cannot lift their own exclusion" (-not (Api Post "/admin/users/$p3Id/lift-exclusion" @{ reason = "let me play" } $P3).ok)
Check "admin needs a real reason to lift it" (-not (Api Post "/admin/users/$p3Id/lift-exclusion" @{ reason = "x" } $A).ok)
Check "admin lifts it with a reason" ((Api Post "/admin/users/$p3Id/lift-exclusion" @{ reason = "Verified request in person" } $A).ok)
Check "the player can play again" ((Api Post "/games/$gid/launch" $null $P3).ok)

$k = Api Post "/kyc/players/$p2Id" @{ status = "verified"; date_of_birth = "1990-05-05"; note = "Test ID check" } $CT
Check "club agent verifies an adult player" $k.ok $k.error
$bad = Api Post "/kyc/players/$p2Id" @{ status = "verified"; date_of_birth = "2012-01-01"; note = "Underage" } $CT
Check "an under-18 date of birth is not accepted as verified" ((-not $bad.ok) -or (($bad.data | ConvertTo-Json) -notmatch '"verified"'))
Check "verification list loads" ((Api Get "/kyc/players" $null $CT).ok)
Recon "after responsible gambling tests"

Section "13. Audit trail"
$au = Api Get "/admin/audit" $null $A
Check "audit log has entries" ($au.ok -and @($au.data).Count -gt 0)
Check "claims, approvals and reversals are in it" ((($au.data | ConvertTo-Json -Depth 4) -match "claim") -and (($au.data | ConvertTo-Json -Depth 4) -match "reverse"))
Recon "at the end"

Section "14. Backup"
if ($SkipBackup) { Warn "backup skipped" } else {
  try {
    & (Join-Path $root "scripts\backup.ps1") | Out-Null
    $newest = Get-ChildItem "C:\franchise-backups" -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Check "a fresh backup file was written" ($newest -and $newest.LastWriteTime -gt (Get-Date).AddMinutes(-3) -and $newest.Length -gt 1000) ("newest: " + $newest.Name)
  } catch { Check "a fresh backup file was written" $false $_.Exception.Message }
}

} catch { $script:failed++; $script:failures += ("SCRIPT STOPPED: " + $_.Exception.Message); Write-Host ("SCRIPT STOPPED: " + $_.Exception.Message) -ForegroundColor Red }

Write-Host ""
Write-Host ("==== RESULT: " + $script:passed + " passed, " + $script:failed + " failed ====") -ForegroundColor $(if ($script:failed -eq 0) { "Green" } else { "Red" })
foreach ($f in $script:failures) { Write-Host ("  FAILED: " + $f) -ForegroundColor Red }
foreach ($w in $script:warnings) { Write-Host ("  NOTE: " + $w) -ForegroundColor Yellow }
exit $script:failed