# Broadcasts DeployNuvem to Robinhood Chain mainnet (4663).
#
#   pwsh/powershell:  .\scripts\deploy-mainnet.ps1            # dry run
#                     .\scripts\deploy-mainnet.ps1 -Broadcast # real deployment
#
# Secrets are read from the gitignored root .env and .env.mainnet and are never
# printed. Everything else is echoed so the configuration can be eyeballed
# before the irreversible step.
#
# THIS IS A ONE-WAY DOOR when run with -Broadcast:
#   - configureProtocol pins the canonical WETH permanently (one-shot)
#   - cohort 1 is created and cohorts are append-only
#   - factory ownership is transferred *pending* to a 7-day TimelockController
#     whose admin is address(0) and whose sole proposer is the corporate Safe
#
# Written for Windows PowerShell 5.1: no &&, no ternary, no null-coalescing.

param([switch]$Broadcast)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot\..

function Import-DotEnv([string]$Path) {
    if (-not (Test-Path $Path)) { throw "Missing env file: $Path" }
    foreach ($line in Get-Content $Path) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $name = $matches[1]
            $value = $matches[2].Trim().Trim('"').Trim("'")
            [Environment]::SetEnvironmentVariable($name, $value, 'Process')
        }
    }
}

Import-DotEnv "..\..\.env"
Import-DotEnv "..\..\.env.mainnet"

if (-not $env:ALCHEMY_API_KEY) { throw "ALCHEMY_API_KEY not found in .env" }

# The deployer must be its own single-purpose key. It holds no privilege after
# the run — VaultFactoryBootstrap is sealed and factory ownership goes to the
# timelock — but DEPLOYMENT.md's key-separation rule is absolute, and reusing the
# trading key here would put the wallet that signs settlements in the deployment
# path. Generate one with:
#   node packages/aa-smoke-old/scripts/new-canary-wallet.mjs NUVEM_DEPLOYER_PRIVATE_KEY .env.mainnet
if (-not $env:NUVEM_DEPLOYER_PRIVATE_KEY) {
    throw "NUVEM_DEPLOYER_PRIVATE_KEY not found. Do not reuse the trading, admin, attester, guardian or Safe-owner keys."
}
if ($env:NUVEM_DEPLOYER_PRIVATE_KEY -eq $env:TRADING_OWNER_PRIVATE_KEY) {
    throw "NUVEM_DEPLOYER_PRIVATE_KEY must differ from TRADING_OWNER_PRIVATE_KEY (DEPLOYMENT.md key separation)."
}
$env:DEPLOYER_PRIVATE_KEY        = $env:NUVEM_DEPLOYER_PRIVATE_KEY
$env:NUVEM_CORPORATE_MULTISIG    = "0x5364D009FFEe533AD8657Fe92973095453aB8205"
$env:NUVEM_GUARDIAN              = "0xED7251decC2Bc054fEb12b40aF7A8431a4b27439"
$env:NUVEM_TREASURY              = "0xBDA30A1AA62AB6099ea2d980134725a4A7420bfE"
$env:NUVEM_ATTESTER              = "0x864743540b6D6E0a38f535e1200c0373e0D7AAde"
# Verified on 4663: name/symbol WETH, 18 decimals, and the GMGN pool from the
# canary holds 978.54 of this exact token. PINNED PERMANENTLY by configureProtocol.
$env:NUVEM_WETH_ADDRESS          = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"
$env:NUVEM_CANARY_APPROVED       = "true"

# NUVEM_TARGET_ASSET_ADDRESS is deliberately NOT set. It belonged to
# VaultPolicy.targetAsset, and VaultPolicy is now the single field
# maxAggregateRolling30dWei — there is no target asset to validate and no adapter
# to route to. DeployNuvem.s.sol no longer reads it at all.
#
# NUVEM_INITIAL_FEE_BPS IS still set, and only because the script still requires
# it: DeployNuvem.s.sol:279 reads it with vm.envUint, which REVERTS when unset.
# It feeds the FeeController constructor, and that contract is deployed but NOT
# pinned into VaultFactory.ProtocolConfiguration (DeployNuvem.s.sol:131-141), so
# no vault can reach it and settlement charges nothing regardless of this value.
# Zero rather than a placeholder, so that if the fee path is ever wired up the
# default is "charge nothing" instead of whatever was left here.
$env:NUVEM_INITIAL_FEE_BPS       = "0"

$rpc = "https://robinhood-mainnet.g.alchemy.com/v2/$($env:ALCHEMY_API_KEY)"

Write-Host ""
Write-Host "corporate Safe : $($env:NUVEM_CORPORATE_MULTISIG)"
Write-Host "guardian       : $($env:NUVEM_GUARDIAN)"
Write-Host "treasury       : $($env:NUVEM_TREASURY)"
Write-Host "attester       : $($env:NUVEM_ATTESTER)"
Write-Host "WETH (pinned)  : $($env:NUVEM_WETH_ADDRESS)"
Write-Host "investing      : not in this deployment - no adapter registry, no target asset"
Write-Host "protocol fee   : none reachable - FeeController deployed at $($env:NUVEM_INITIAL_FEE_BPS) bps but not pinned"
Write-Host "mode           : $(if ($Broadcast) { 'BROADCAST - irreversible' } else { 'dry run' })"
Write-Host ""

$forgeArgs = @(
    "script", "script/DeployNuvem.s.sol:DeployNuvem",
    "--rpc-url", $rpc
)
if ($Broadcast) { $forgeArgs += @("--broadcast", "--slow") }

& forge @forgeArgs
