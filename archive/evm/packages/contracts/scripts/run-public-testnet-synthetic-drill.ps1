[CmdletBinding()]
param(
    [switch]$Broadcast,
    [string]$EnvFile = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ContractsRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$WorkspaceRoot = (Resolve-Path (Join-Path $ContractsRoot "../..")).Path
$DeploymentsDir = Join-Path $ContractsRoot "deployments"
$ChainId = 46630
$RpcAlias = "robinhood_testnet"
$BroadcastConfirmation = "46630_SYNTHETIC_ONLY"
$EnvironmentState = @{}

$RequiredEnvironmentNames = @(
    "RH_TESTNET_RPC_URL",
    "PUBLIC_TESTNET_DRILL_ACKNOWLEDGE_SYNTHETIC",
    "PUBLIC_TESTNET_DRILL_RUN_ID",
    "PUBLIC_TESTNET_DRILL_WETH_ADDRESS",
    "PUBLIC_TESTNET_DRILL_WETH_CODEHASH",
    "PUBLIC_TESTNET_DRILL_DEPLOYER_PRIVATE_KEY",
    "PUBLIC_TESTNET_DRILL_VAULT_ADMIN_PRIVATE_KEY",
    "PUBLIC_TESTNET_DRILL_TRADER_A_PRIVATE_KEY",
    "PUBLIC_TESTNET_DRILL_TRADER_B_PRIVATE_KEY",
    "PUBLIC_TESTNET_DRILL_ATTESTER_PRIVATE_KEY",
    "PUBLIC_TESTNET_DRILL_VAULT_ADMIN_FUNDING_WEI",
    "PUBLIC_TESTNET_DRILL_TRADER_A_FUNDING_WEI",
    "PUBLIC_TESTNET_DRILL_TRADER_B_FUNDING_WEI",
    "PUBLIC_TESTNET_DRILL_MARKET_LIQUIDITY_WEI",
    "PUBLIC_TESTNET_DRILL_DEPLOYER_GAS_BUDGET_WEI",
    "PUBLIC_TESTNET_DRILL_PARTICIPANT_GAS_BUDGET_WEI",
    "PUBLIC_TESTNET_DRILL_TRADE_A_WEI",
    "PUBLIC_TESTNET_DRILL_TRADE_B_WEI",
    "PUBLIC_TESTNET_DRILL_INITIAL_PRICE_WEI",
    "PUBLIC_TESTNET_DRILL_FINAL_PRICE_WEI",
    "PUBLIC_TESTNET_DRILL_TRADER_A_INITIAL_BPS",
    "PUBLIC_TESTNET_DRILL_TRADER_A_UPDATED_BPS",
    "PUBLIC_TESTNET_DRILL_TRADER_B_BPS",
    "PUBLIC_TESTNET_DRILL_MIN_CONTRIBUTION_WEI",
    "PUBLIC_TESTNET_DRILL_TRADING_FLOOR_WEI",
    "PUBLIC_TESTNET_DRILL_GAS_RESERVE_WEI",
    "PUBLIC_TESTNET_DRILL_INVITE_LIFETIME_SECONDS",
    "PUBLIC_TESTNET_DRILL_TX_DEADLINE_SECONDS"
)
# ADAPTER_RATE_WAD, NORMAL_FEE_BPS and MIN_INVESTMENT_WEI were required here until
# the investment path was removed. Nothing under script/, src/ or test/ has read
# them since, so demanding them only made the drill refuse to start over values
# that could no longer change its behaviour.

$RuntimeEnvironmentNames = @(
    "ETH_RPC_URL",
    "PUBLIC_TESTNET_DRILL_LEDGER_ROOT_A",
    "PUBLIC_TESTNET_DRILL_LEDGER_ROOT_B",
    "PUBLIC_TESTNET_DRILL_TRADE_START_BLOCK_A",
    "PUBLIC_TESTNET_DRILL_TRADE_END_BLOCK_A",
    "PUBLIC_TESTNET_DRILL_TRADE_START_BLOCK_B",
    "PUBLIC_TESTNET_DRILL_TRADE_END_BLOCK_B",
    "PUBLIC_TESTNET_DRILL_TRADE_START_BLOCK_L2_A",
    "PUBLIC_TESTNET_DRILL_TRADE_END_BLOCK_L2_A",
    "PUBLIC_TESTNET_DRILL_TRADE_START_BLOCK_L2_B",
    "PUBLIC_TESTNET_DRILL_TRADE_END_BLOCK_L2_B",
    "PUBLIC_TESTNET_DRILL_CASH_START_A",
    "PUBLIC_TESTNET_DRILL_CASH_END_A",
    "PUBLIC_TESTNET_DRILL_CASH_START_B",
    "PUBLIC_TESTNET_DRILL_CASH_END_B"
)

function Save-EnvironmentState {
    param([Parameter(Mandatory = $true)][string]$Name)

    if ($EnvironmentState.ContainsKey($Name)) {
        return
    }
    $existing = Get-Item -LiteralPath "Env:\$Name" -ErrorAction SilentlyContinue
    $EnvironmentState[$Name] = [ordered]@{
        Exists = $null -ne $existing
        Value = if ($null -ne $existing) { [string]$existing.Value } else { "" }
    }
}

function Set-ScopedEnvironmentValue {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Value
    )

    Save-EnvironmentState $Name
    Set-Item -LiteralPath "Env:\$Name" -Value $Value
}

function Restore-Environment {
    foreach ($name in $EnvironmentState.Keys) {
        $state = $EnvironmentState[$name]
        if ($state.Exists) {
            Set-Item -LiteralPath "Env:\$name" -Value $state.Value
        } else {
            Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue
        }
    }
}

function Import-DotEnv {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Environment file not found: $Path"
    }
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith("#")) {
            continue
        }
        if ($line -notmatch "^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$") {
            throw "Invalid .env line for key-only parser; comments must be on their own line"
        }
        $name = $Matches[1]
        if ($name -ne "RH_TESTNET_RPC_URL" -and -not $name.StartsWith("PUBLIC_TESTNET_DRILL_")) {
            continue
        }
        if (Test-Path -LiteralPath "Env:\$name") {
            continue
        }
        $value = $Matches[2].Trim()
        if (
            $value.Length -ge 2 -and
            (($value.StartsWith('"') -and $value.EndsWith('"')) -or
             ($value.StartsWith("'") -and $value.EndsWith("'")))
        ) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        Set-ScopedEnvironmentValue -Name $name -Value $value
    }
}

function Get-RequiredEnvironmentValue {
    param([Parameter(Mandatory = $true)][string]$Name)

    $item = Get-Item -LiteralPath "Env:\$Name" -ErrorAction SilentlyContinue
    if ($null -eq $item -or [string]::IsNullOrWhiteSpace([string]$item.Value)) {
        throw "Required environment variable is blank: $Name"
    }
    return [string]$item.Value
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )

    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Executable failed with exit code $LASTEXITCODE"
    }
}

function Convert-HexToBigInteger {
    param([Parameter(Mandatory = $true)]$Value)

    $text = ([string]$Value).Trim()
    if ($text.StartsWith("0x")) {
        if ($text.Length -eq 2) {
            return [System.Numerics.BigInteger]::Zero
        }
        return [System.Numerics.BigInteger]::Parse(
            "0" + $text.Substring(2),
            [System.Globalization.NumberStyles]::AllowHexSpecifier
        )
    }
    return [System.Numerics.BigInteger]::Parse($text)
}

function Invoke-CastValue {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    $output = (& cast @Arguments).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($output)) {
        throw "Read-only cast command failed"
    }
    return $output
}

function Get-ReceiptSummary {
    param(
        [Parameter(Mandatory = $true)]$Transaction,
        [Parameter(Mandatory = $true)]$Receipt
    )

    $logsJson = @($Receipt.logs) | ConvertTo-Json -Depth 30 -Compress
    $logsHash = (Invoke-CastValue keccak $logsJson).Trim()
    $gasUsed = Convert-HexToBigInteger $Receipt.gasUsed
    $effectiveGasPrice = Convert-HexToBigInteger $Receipt.effectiveGasPrice
    return [ordered]@{
        function = [string]$Transaction.function
        transactionHash = [string]$Receipt.transactionHash
        blockHash = [string]$Receipt.blockHash
        blockNumber = (Convert-HexToBigInteger $Receipt.blockNumber).ToString()
        gasUsed = $gasUsed.ToString()
        effectiveGasPrice = $effectiveGasPrice.ToString()
        gasCostWei = ($gasUsed * $effectiveGasPrice).ToString()
        logsHash = $logsHash
        logs = @($Receipt.logs)
        status = [string]$Receipt.status
    }
}

function Read-VerifiedBroadcast {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing broadcast evidence: $Path"
    }
    $broadcast = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    $transactions = @($broadcast.transactions)
    $receipts = @($broadcast.receipts)
    if ($transactions.Count -eq 0 -or $transactions.Count -ne $receipts.Count) {
        throw "Broadcast transaction/receipt count mismatch in $Path"
    }

    $receiptByHash = @{}
    foreach ($receipt in $receipts) {
        if ([string]$receipt.status -notin @("0x1", "1")) {
            throw "Failed transaction in $Path"
        }
        if (
            [string]::IsNullOrWhiteSpace([string]$receipt.transactionHash) -or
            [string]::IsNullOrWhiteSpace([string]$receipt.blockHash)
        ) {
            throw "Receipt without transaction/block hash in $Path"
        }
        $receiptByHash[[string]$receipt.transactionHash.ToLowerInvariant()] = $receipt
    }

    $summaries = @()
    foreach ($transaction in $transactions) {
        $hash = [string]$transaction.hash
        if ([string]::IsNullOrWhiteSpace($hash)) {
            throw "Broadcast transaction without hash in $Path"
        }
        $key = $hash.ToLowerInvariant()
        if (-not $receiptByHash.ContainsKey($key)) {
            throw "No receipt for a broadcast transaction in $Path"
        }
        $summaries += Get-ReceiptSummary -Transaction $transaction -Receipt $receiptByHash[$key]
    }

    return [ordered]@{
        path = $Path
        transactionCount = $transactions.Count
        transactions = $transactions
        receipts = $receipts
        summaries = $summaries
    }
}

function Find-TransactionReceipt {
    param(
        [Parameter(Mandatory = $true)]$BroadcastData,
        [Parameter(Mandatory = $true)][string]$From,
        [Parameter(Mandatory = $true)][string]$FunctionPrefix
    )

    $matches = @($BroadcastData.transactions | Where-Object {
        ([string]$_.transaction.from).ToLowerInvariant() -eq $From.ToLowerInvariant() -and
        ([string]$_.function).StartsWith($FunctionPrefix)
    })
    if ($matches.Count -ne 1) {
        throw "Expected one $FunctionPrefix transaction from $From, found $($matches.Count)"
    }
    $hash = ([string]$matches[0].hash).ToLowerInvariant()
    $receipt = @($BroadcastData.receipts | Where-Object {
        ([string]$_.transactionHash).ToLowerInvariant() -eq $hash
    })
    if ($receipt.Count -ne 1) {
        throw "Expected one receipt for a matched $FunctionPrefix transaction"
    }
    return Get-ReceiptSummary -Transaction $matches[0] -Receipt $receipt[0]
}

function Get-TokenBalance {
    param(
        [Parameter(Mandatory = $true)][string]$Token,
        [Parameter(Mandatory = $true)][string]$Account,
        [Parameter(Mandatory = $true)][string]$Block
    )

    return Convert-HexToBigInteger (Invoke-CastValue erc20 balance $Token $Account --block $Block)
}

function Get-NativeBalance {
    param(
        [Parameter(Mandatory = $true)][string]$Account,
        [Parameter(Mandatory = $true)][string]$Block
    )

    return Convert-HexToBigInteger (Invoke-CastValue balance $Account --block $Block)
}

function Get-L1BlockNumber {
    param([Parameter(Mandatory = $true)][System.Numerics.BigInteger]$L2Block)

    # BigInteger.ToString("x") pads a leading zero whenever the top nibble is set,
    # so 255 renders as "0ff". A JSON-RPC quantity must carry no leading zeros and
    # strict nodes reject one, hence the trim.
    $hex = $L2Block.ToString("x").TrimStart("0")
    if ([string]::IsNullOrEmpty($hex)) {
        $hex = "0"
    }
    $block = (Invoke-CastValue rpc eth_getBlockByNumber "0x$hex" false) | ConvertFrom-Json
    if (-not ($block.PSObject.Properties.Name -contains "l1BlockNumber")) {
        throw "Block $L2Block does not report l1BlockNumber; this RPC cannot supply the L1 clock the settlement needs"
    }
    return Convert-HexToBigInteger ([string]$block.l1BlockNumber)
}

function Wait-ForConfirmedBlock {
    param(
        [Parameter(Mandatory = $true)][System.Numerics.BigInteger]$IncludedBlock,
        [Parameter(Mandatory = $true)][int]$Confirmations
    )

    $targetBlock = $IncludedBlock + [System.Numerics.BigInteger]$Confirmations
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        $currentBlock = Convert-HexToBigInteger (Invoke-CastValue block-number)
        if ($currentBlock -ge $targetBlock) {
            return
        }
        Start-Sleep -Seconds 5
    }
    throw "Timed out waiting for a public block after trade inclusion; rerun after the chain advances"
}

function Get-MaximumReceiptBlock {
    param([Parameter(Mandatory = $true)]$BroadcastData)

    $maximum = [System.Numerics.BigInteger]::Zero
    foreach ($summary in $BroadcastData.summaries) {
        $block = [System.Numerics.BigInteger]::Parse([string]$summary.blockNumber)
        if ($block -gt $maximum) {
            $maximum = $block
        }
    }
    return $maximum
}

function New-TraderEvidence {
    param(
        [Parameter(Mandatory = $true)]$BroadcastData,
        [Parameter(Mandatory = $true)][string]$Account,
        [Parameter(Mandatory = $true)][string]$Weth,
        [Parameter(Mandatory = $true)][string]$Stock,
        [Parameter(Mandatory = $true)][string]$Market,
        [Parameter(Mandatory = $true)][int]$SavingsBps,
        [Parameter(Mandatory = $true)][string]$GrossProfitWei,
        [string]$SetupFunctionPrefix = ""
    )

    $buy = Find-TransactionReceipt -BroadcastData $BroadcastData -From $Account -FunctionPrefix "buy("
    $approve = Find-TransactionReceipt -BroadcastData $BroadcastData -From $Account -FunctionPrefix "approve("
    $sell = Find-TransactionReceipt -BroadcastData $BroadcastData -From $Account -FunctionPrefix "sell("
    # THE TWO CLOCKS. A receipt's blockNumber on this chain is the L2 height, which
    # is what an RPC reports and what `cast --block` indexes by. `block.number`
    # inside the EVM is the L1 height, and on this chain the two are ~85 MILLION
    # apart. Feeding the L2 number into the attestation's L1 range is what makes a
    # settlement revert with InvalidTradeRange — the exact failure recorded in
    # docs/canary/MAINNET_SETTLEMENT_RESULTS.md. So both are derived here, from the
    # same blocks, and kept apart by name from this point on.
    $startBlockL2 = [System.Numerics.BigInteger]::Parse($buy.blockNumber)
    $sessionTransactions = @($buy, $approve, $sell)
    $setupGasCost = [System.Numerics.BigInteger]::Zero
    if (-not [string]::IsNullOrWhiteSpace($SetupFunctionPrefix)) {
        $setup = Find-TransactionReceipt `
            -BroadcastData $BroadcastData `
            -From $Account `
            -FunctionPrefix $SetupFunctionPrefix
        $setupBlock = [System.Numerics.BigInteger]::Parse($setup.blockNumber)
        if ($setupBlock -lt $startBlockL2) {
            $startBlockL2 = $setupBlock
        }
        $setupGasCost = [System.Numerics.BigInteger]::Parse($setup.gasCostWei)
        $sessionTransactions = @($setup, $buy, $approve, $sell)
    }
    $endBlockL2 = [System.Numerics.BigInteger]::Parse($sell.blockNumber)
    $preTradeBlock = $startBlockL2 - [System.Numerics.BigInteger]::One
    if ($preTradeBlock -lt 0) {
        throw "Invalid pre-trade block"
    }

    $startBlockL1 = Get-L1BlockNumber -L2Block $startBlockL2
    $endBlockL1 = Get-L1BlockNumber -L2Block $endBlockL2
    if ($endBlockL1 -lt $startBlockL1) {
        throw "L1 range runs backwards for $Account; the chain reported a decreasing l1BlockNumber"
    }
    if ($startBlockL2 -eq 0) {
        throw "L2 range starts at block zero for $Account, which the settlement script rejects as malformed"
    }

    $nativeStart = Get-NativeBalance -Account $Account -Block $preTradeBlock.ToString()
    $wethStart = Get-TokenBalance -Token $Weth -Account $Account -Block $preTradeBlock.ToString()
    $nativeEnd = Get-NativeBalance -Account $Account -Block $endBlockL2.ToString()
    $wethEnd = Get-TokenBalance -Token $Weth -Account $Account -Block $endBlockL2.ToString()
    $cashStart = $nativeStart + $wethStart
    $cashEnd = $nativeEnd + $wethEnd
    if ($cashEnd -le $cashStart) {
        throw "Trader $Account did not realize positive net PnL after gas"
    }

    $profit = $cashEnd - $cashStart
    $totalTradingGasCost =
        $setupGasCost +
        [System.Numerics.BigInteger]::Parse($buy.gasCostWei) +
        [System.Numerics.BigInteger]::Parse($approve.gasCostWei) +
        [System.Numerics.BigInteger]::Parse($sell.gasCostWei)
    $grossProfit = [System.Numerics.BigInteger]::Parse($GrossProfitWei)
    if ($profit -ne $grossProfit - $totalTradingGasCost) {
        throw "Gas-inclusive PnL reconciliation failed for $Account"
    }
    $contribution = ($profit * $SavingsBps) / 10000

    $canonical = [ordered]@{
        schema = "nuvem.public-testnet.synthetic-receipt-ledger.v2"
        environment = "PUBLIC_TESTNET_SYNTHETIC_NOT_PRODUCTION"
        chainId = "$ChainId"
        account = $Account.ToLowerInvariant()
        nativeToken = "0x0000000000000000000000000000000000000000"
        weth = $Weth.ToLowerInvariant()
        syntheticStock = $Stock.ToLowerInvariant()
        syntheticMarket = $Market.ToLowerInvariant()
        # v2 names both clocks. v1 called the L2 heights "startBlock"/"endBlock",
        # which read as the L1 range the attestation asks for and is exactly the
        # ambiguity that produced the reverting settlement on mainnet.
        startBlockL2 = $startBlockL2.ToString()
        endBlockL2 = $endBlockL2.ToString()
        startBlockL1 = $startBlockL1.ToString()
        endBlockL1 = $endBlockL1.ToString()
        cashStartNativePlusWeth = $cashStart.ToString()
        cashEndNativePlusWeth = $cashEnd.ToString()
        grossRealizedProfitBeforeGas = $grossProfit.ToString()
        totalTradingGasCostWei = $totalTradingGasCost.ToString()
        netRealizedProfitAfterGas = $profit.ToString()
        externalDeposits = "0"
        externalWithdrawals = "0"
        deployerFundingClassification = "pre-session funding"
        transactions = $sessionTransactions
    }
    $canonicalJson = $canonical | ConvertTo-Json -Depth 40 -Compress
    $ledgerRoot = (Invoke-CastValue keccak $canonicalJson).Trim()
    if (-not $ledgerRoot.StartsWith("0x")) {
        throw "Unable to derive ledger root for $Account"
    }

    return [ordered]@{
        ledgerRoot = $ledgerRoot
        cashStartNative = $nativeStart.ToString()
        cashStartWeth = $wethStart.ToString()
        cashStart = $cashStart.ToString()
        cashEndNative = $nativeEnd.ToString()
        cashEndWeth = $wethEnd.ToString()
        cashEnd = $cashEnd.ToString()
        grossRealizedProfitBeforeGas = $grossProfit.ToString()
        totalTradingGasCostWei = $totalTradingGasCost.ToString()
        netRealizedProfitAfterGas = $profit.ToString()
        savingsBps = $SavingsBps
        contribution = $contribution.ToString()
        startBlockL2 = $startBlockL2.ToString()
        endBlockL2 = $endBlockL2.ToString()
        startBlockL1 = $startBlockL1.ToString()
        endBlockL1 = $endBlockL1.ToString()
        canonicalLedger = $canonical
    }
}

try {
    foreach ($tool in @("cast", "forge")) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            throw "Required executable not found: $tool"
        }
    }

    if ([string]::IsNullOrWhiteSpace($EnvFile)) {
        $EnvFile = Join-Path $WorkspaceRoot ".env"
    }
    Import-DotEnv -Path ([System.IO.Path]::GetFullPath($EnvFile))
    foreach ($name in $RequiredEnvironmentNames) {
        [void](Get-RequiredEnvironmentValue $name)
    }
    if ((Get-RequiredEnvironmentValue "PUBLIC_TESTNET_DRILL_ACKNOWLEDGE_SYNTHETIC").ToLowerInvariant() -ne "true") {
        throw "PUBLIC_TESTNET_DRILL_ACKNOWLEDGE_SYNTHETIC must be exactly true"
    }

    $rpcUrl = Get-RequiredEnvironmentValue "RH_TESTNET_RPC_URL"
    Set-ScopedEnvironmentValue -Name "ETH_RPC_URL" -Value $rpcUrl

    $confirmations = 2
    $configuredConfirmations =
        Get-Item -LiteralPath "Env:\PUBLIC_TESTNET_DRILL_CONFIRMATIONS" -ErrorAction SilentlyContinue
    if ($null -ne $configuredConfirmations -and -not [string]::IsNullOrWhiteSpace($configuredConfirmations.Value)) {
        $confirmations = [int]$configuredConfirmations.Value
    }
    if ($confirmations -lt 1 -or $confirmations -gt 12) {
        throw "PUBLIC_TESTNET_DRILL_CONFIRMATIONS must be between 1 and 12"
    }

    Push-Location $ContractsRoot
    try {
        $actualChainId = [int](Invoke-CastValue chain-id)
        if ($actualChainId -ne $ChainId) {
            throw "Public-testnet drill requires chain ID $ChainId; RPC returned $actualChainId"
        }

        $currentBlock = Convert-HexToBigInteger (Invoke-CastValue block-number)
        if ($currentBlock -lt 2) {
            throw "RPC block height is unexpectedly low"
        }
        # Historical state is required for gas-inclusive cash snapshots.
        $historicalBlock = ($currentBlock - 2).ToString()
        [void](Invoke-CastValue balance "0x0000000000000000000000000000000000000001" --block $historicalBlock)

        Invoke-Checked forge test --match-path "test/unit/script/PublicTestnetDrillScripts.t.sol" -vv
        Invoke-Checked forge script "script/PreflightPublicTestnetDrill.s.sol:PreflightPublicTestnetDrill" `
            --rpc-url $RpcAlias -vv

        if (-not $Broadcast) {
            Write-Host "PUBLIC TESTNET SYNTHETIC DRILL: PREFLIGHT ONLY"
            Write-Host "Chain ID: $ChainId"
            Write-Host "No transaction was broadcast and no private key was printed."
            Write-Host "Use the explicit broadcast package command only after reviewing the preflight."
            return
        }

        $confirmationValue =
            Get-RequiredEnvironmentValue "PUBLIC_TESTNET_DRILL_BROADCAST_CONFIRMATION"
        if ($confirmationValue -ne $BroadcastConfirmation) {
            throw "Broadcast blocked: PUBLIC_TESTNET_DRILL_BROADCAST_CONFIRMATION must equal $BroadcastConfirmation"
        }

        if (-not (Test-Path -LiteralPath $DeploymentsDir)) {
            New-Item -ItemType Directory -Path $DeploymentsDir | Out-Null
        }
        $deploymentPath = Join-Path $DeploymentsDir "public-testnet-synthetic-drill-$ChainId.json"
        $resultsPath =
            Join-Path $DeploymentsDir "public-testnet-synthetic-drill-results-$ChainId.json"
        $receiptEvidencePath =
            Join-Path $DeploymentsDir "public-testnet-synthetic-drill-receipts-$ChainId.json"
        $broadcastEvidencePath =
            Join-Path $DeploymentsDir "public-testnet-synthetic-drill-broadcasts-$ChainId.json"
        foreach (
            $protectedOutput in @(
                $deploymentPath,
                $resultsPath,
                $receiptEvidencePath,
                $broadcastEvidencePath
            )
        ) {
            if (Test-Path -LiteralPath $protectedOutput) {
                throw "Refusing to overwrite existing drill output: $protectedOutput"
            }
        }

        Invoke-Checked forge script "script/DeployPublicTestnetDrill.s.sol:DeployPublicTestnetDrill" `
            --rpc-url $RpcAlias --broadcast --slow -vv
        $setupBroadcastPath =
            Join-Path $ContractsRoot "broadcast/DeployPublicTestnetDrill.s.sol/$ChainId/run-latest.json"
        $setupBroadcast = Read-VerifiedBroadcast $setupBroadcastPath
        $deployment = Get-Content -Raw -LiteralPath $deploymentPath | ConvertFrom-Json

        Invoke-Checked forge script "script/ExecutePublicTestnetTrades.s.sol:ExecutePublicTestnetTrades" `
            --rpc-url $RpcAlias --broadcast --slow -vv
        $tradeBroadcastPath =
            Join-Path $ContractsRoot "broadcast/ExecutePublicTestnetTrades.s.sol/$ChainId/run-latest.json"
        $tradeBroadcast = Read-VerifiedBroadcast $tradeBroadcastPath
        Wait-ForConfirmedBlock `
            -IncludedBlock (Get-MaximumReceiptBlock $tradeBroadcast) `
            -Confirmations $confirmations

        $evidenceA = New-TraderEvidence `
            -BroadcastData $tradeBroadcast `
            -Account ([string]$deployment.traderA) `
            -Weth ([string]$deployment.weth) `
            -Stock ([string]$deployment.stock) `
            -Market ([string]$deployment.market) `
            -SavingsBps ([int]$deployment.traderAUpdatedSavingsBps) `
            -GrossProfitWei ([string]$deployment.grossProfitAWei) `
            -SetupFunctionPrefix "setMySavingsBps("
        $evidenceB = New-TraderEvidence `
            -BroadcastData $tradeBroadcast `
            -Account ([string]$deployment.traderB) `
            -Weth ([string]$deployment.weth) `
            -Stock ([string]$deployment.stock) `
            -Market ([string]$deployment.market) `
            -SavingsBps ([int]$deployment.traderBSavingsBps) `
            -GrossProfitWei ([string]$deployment.grossProfitBWei)

        $minContribution =
            [System.Numerics.BigInteger]::Parse([string]$deployment.minContributionWei)
        $contributionA = [System.Numerics.BigInteger]::Parse($evidenceA.contribution)
        $contributionB = [System.Numerics.BigInteger]::Parse($evidenceB.contribution)
        if ($contributionA -lt $minContribution -or $contributionB -lt $minContribution) {
            throw "Net-of-gas contribution fell below configured settlement minimum"
        }

        Set-ScopedEnvironmentValue "PUBLIC_TESTNET_DRILL_LEDGER_ROOT_A" $evidenceA.ledgerRoot
        Set-ScopedEnvironmentValue "PUBLIC_TESTNET_DRILL_LEDGER_ROOT_B" $evidenceB.ledgerRoot
        # TRADE_START_BLOCK_* is the L1 range the attestation is bounded by, and
        # TRADE_START_BLOCK_L2_* the observed L2 range. Crossing these two is a
        # settlement that reverts, so they are assigned from separately named fields.
        Set-ScopedEnvironmentValue "PUBLIC_TESTNET_DRILL_TRADE_START_BLOCK_A" $evidenceA.startBlockL1
        Set-ScopedEnvironmentValue "PUBLIC_TESTNET_DRILL_TRADE_END_BLOCK_A" $evidenceA.endBlockL1
        Set-ScopedEnvironmentValue "PUBLIC_TESTNET_DRILL_TRADE_START_BLOCK_B" $evidenceB.startBlockL1
        Set-ScopedEnvironmentValue "PUBLIC_TESTNET_DRILL_TRADE_END_BLOCK_B" $evidenceB.endBlockL1
        Set-ScopedEnvironmentValue "PUBLIC_TESTNET_DRILL_TRADE_START_BLOCK_L2_A" $evidenceA.startBlockL2
        Set-ScopedEnvironmentValue "PUBLIC_TESTNET_DRILL_TRADE_END_BLOCK_L2_A" $evidenceA.endBlockL2
        Set-ScopedEnvironmentValue "PUBLIC_TESTNET_DRILL_TRADE_START_BLOCK_L2_B" $evidenceB.startBlockL2
        Set-ScopedEnvironmentValue "PUBLIC_TESTNET_DRILL_TRADE_END_BLOCK_L2_B" $evidenceB.endBlockL2
        Set-ScopedEnvironmentValue "PUBLIC_TESTNET_DRILL_CASH_START_A" $evidenceA.cashStart
        Set-ScopedEnvironmentValue "PUBLIC_TESTNET_DRILL_CASH_END_A" $evidenceA.cashEnd
        Set-ScopedEnvironmentValue "PUBLIC_TESTNET_DRILL_CASH_START_B" $evidenceB.cashStart
        Set-ScopedEnvironmentValue "PUBLIC_TESTNET_DRILL_CASH_END_B" $evidenceB.cashEnd

        # The investment split that stood here computed a three-way spend from
        # $deployment.minInvestmentWei and $deployment.normalFeeBps. The deploy
        # script stopped serialising both fields when the investment path was
        # removed, so under Set-StrictMode those two reads were a guaranteed
        # "property not found" — mid-broadcast, after real testnet funds had already
        # been spent on the deploy and trade phases. Nothing consumed the values it
        # exported either.

        $receiptEvidence = [ordered]@{
            schema = "nuvem.public-testnet.synthetic-drill-evidence.v1"
            environment = "PUBLIC_TESTNET_SYNTHETIC_NOT_PRODUCTION"
            chainId = $ChainId
            runId = [string]$deployment.runId
            setupTransactionCount = $setupBroadcast.transactionCount
            traderA = $evidenceA
            traderB = $evidenceB
        }
        $receiptEvidence |
            ConvertTo-Json -Depth 50 |
            Set-Content -LiteralPath $receiptEvidencePath -Encoding UTF8

        Invoke-Checked forge script `
            "script/SettlePublicTestnetDrill.s.sol:SettlePublicTestnetDrill" `
            --rpc-url $RpcAlias --broadcast --slow -vv
        $settlementBroadcastPath =
            Join-Path $ContractsRoot `
                "broadcast/SettlePublicTestnetDrill.s.sol/$ChainId/run-latest.json"
        $settlementBroadcast = Read-VerifiedBroadcast $settlementBroadcastPath
        Wait-ForConfirmedBlock `
            -IncludedBlock (Get-MaximumReceiptBlock $settlementBroadcast) `
            -Confirmations $confirmations

        Invoke-Checked forge script `
            "script/VerifyPublicTestnetDrill.s.sol:VerifyPublicTestnetDrill" `
            --rpc-url $RpcAlias -vv
        $results = Get-Content -Raw -LiteralPath $resultsPath | ConvertFrom-Json
        if ([string]$results.status -ne "verified") {
            throw "Post-broadcast verification did not produce verified status"
        }

        $broadcastEvidence = [ordered]@{
            schema = "nuvem.public-testnet.synthetic-broadcast-evidence.v1"
            environment = "PUBLIC_TESTNET_SYNTHETIC_NOT_PRODUCTION"
            chainId = $ChainId
            runId = [string]$deployment.runId
            status = "verified"
            setup = $setupBroadcast.summaries
            trades = $tradeBroadcast.summaries
            settlement = $settlementBroadcast.summaries
        }
        $broadcastEvidence |
            ConvertTo-Json -Depth 50 |
            Set-Content -LiteralPath $broadcastEvidencePath -Encoding UTF8

        Write-Host "PUBLIC TESTNET SYNTHETIC DRILL: VERIFIED"
        Write-Host "Chain ID: $ChainId"
        Write-Host "Deployment: $deploymentPath"
        Write-Host "Receipt ledger evidence: $receiptEvidencePath"
        Write-Host "Broadcast receipt evidence: $broadcastEvidencePath"
        Write-Host "Final state: $resultsPath"
        Write-Host "This proves only the isolated synthetic testnet topology, not production readiness."
    } finally {
        Pop-Location
    }
} finally {
    Restore-Environment
}
