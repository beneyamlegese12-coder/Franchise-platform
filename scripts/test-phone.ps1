param([string]$DemoPass = "Demo#2026pass")
$base = "http://localhost:4000/api/v1"
$playerSite = @{ Origin = "http://localhost:5173" }
$script:passed = 0; $script:failed = 0
function Api($method, $path, $body = $null, $token = $null, $headers = @{}) {
  $h = @{}; foreach ($k in $headers.Keys) { $h[$k] = $headers[$k] }
  if ($token) { $h["Authorization"] = "Bearer $token" }
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
function Login($phone, $pw) {
  for ($i = 0; $i -lt 6; $i++) {
    $r = Api Post "/auth/login" @{ phone = $phone; password = $pw } $null $playerSite
    if ($r.status -ne 429 -or $r.error -match "failed attempts") { return $r }
    Start-Sleep 12
  }
  return $r
}
$n = Get-Random -Minimum 10000000 -Maximum 99999999
$d9 = "9$n"; $e164 = "+251$d9"
$pw = "Welcome!Mika2026x"

Write-Host "== Players"
$r = Api Post "/auth/register" @{ phone = "0$d9"; display_name = "Phone Test"; password = $pw; date_of_birth = "1995-04-12" } $null $playerSite
Check "register with 09... format" $r.ok $r.error
Check "it is stored as +251..." ($r.data.user.username -eq $e164) ("stored " + $r.data.user.username)
foreach ($fmt in @($e164, "0$d9", $d9, "251$d9", ("0" + $d9.Substring(0,2) + " " + $d9.Substring(2,4) + " " + $d9.Substring(6)))) {
  Check ("sign in with " + $fmt) ((Login $fmt $pw).ok)
}
Check "same number in another format is refused" (-not (Api Post "/auth/register" @{ phone = $e164; display_name = "Again"; password = $pw; date_of_birth = "1995-04-12" } $null $playerSite).ok)
$w = Login "0$d9" "WrongPass#1"
Check "wrong password gives the phone message" ((-not $w.ok) -and $w.error -match "phone number")
Check "a made-up phone number is refused" (-not (Login "abc123" $pw).ok)
Check "a foreign-looking number is refused" (-not (Login "+14155550123" $pw).ok)
Check "registering with a username instead of a phone is refused" (-not (Api Post "/auth/register" @{ username = "someone"; display_name = "X"; password = $pw; date_of_birth = "1995-04-12" } $null $playerSite).ok)
Check "registering with a bad phone is refused" (-not (Api Post "/auth/register" @{ phone = "12345"; display_name = "X"; password = $pw; date_of_birth = "1995-04-12" } $null $playerSite).ok)
$m = Get-Random -Minimum 10000000 -Maximum 99999999
Check "a password containing the phone number is refused" (-not (Api Post "/auth/register" @{ phone = "09$m"; display_name = "X"; password = ("Aa1" + "9$m" + "zz"); date_of_birth = "1995-04-12" } $null $playerSite).ok)

Write-Host "== Staff"
$a = Api Post "/auth/login" @{ username = "nexus_admin"; password = $DemoPass }
Check "admin can still use the API with a username while that is allowed" $a.ok $a.error
if ($a.ok) {
  $A = $a.data.token
  $users = (Api Get "/admin/users" $null $A).data
  $superId = [int](@($users | Where-Object { $_.username -eq "vortex_elite" })[0].id)
  $c9 = "9" + (Get-Random -Minimum 10000000 -Maximum 99999999)
  $mk = Api Post "/admin/users" @{ role = "club"; parent_id = $superId; phone = "0$c9"; display_name = "Phone Club"; password = "Club#Test2026x"; deposit_rate_bps = 500; withdrawal_rate_bps = 100 } $A
  Check "admin creates a club agent by phone" $mk.ok $mk.error
  Check "the club agent signs in with that phone" ((Login "+251$c9" "Club#Test2026x").ok)
  Check "creating a second account with the same phone is refused" (-not (Api Post "/admin/users" @{ role = "club"; parent_id = $superId; phone = "+251$c9"; display_name = "Dup"; password = "Club#Test2026x"; deposit_rate_bps = 500; withdrawal_rate_bps = 100 } $A).ok)
  Check "admin cannot create a user with a bad phone" (-not (Api Post "/admin/users" @{ role = "club"; parent_id = $superId; phone = "nope"; display_name = "Bad"; password = "Club#Test2026x"; deposit_rate_bps = 500; withdrawal_rate_bps = 100 } $A).ok)
  $club = Login "+251$c9" "Club#Test2026x"
  $p9 = "9" + (Get-Random -Minimum 10000000 -Maximum 99999999)
  $np = Api Post "/players" @{ phone = "0$p9"; display_name = "Added Player"; password = "Player#Test2026" } $null @{ Authorization = "Bearer " + $club.data.token }
  Check "club agent adds a player by phone" $np.ok $np.error
  Check "that player signs in with the phone" ((Login "+251$p9" "Player#Test2026").ok)
}
Write-Host ""
Write-Host ("==== RESULT: " + $script:passed + " passed, " + $script:failed + " failed ====") -ForegroundColor $(if ($script:failed -eq 0) { "Green" } else { "Red" })
exit $script:failed