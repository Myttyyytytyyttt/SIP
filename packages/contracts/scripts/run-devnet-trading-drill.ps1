[CmdletBinding()]
param(
    [int]$Port = 8545,
    [switch]$KeepAnvil
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ContractsRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$DeploymentsDir = Join-Path $ContractsRoot "deployments"
$RpcUrl = "http://127.0.0.1:$Port"
$ChainId = 31337
$Mnemonic = "test test test test test test test test test test test junk"
$AnvilProcess = $null
$EnvironmentNames = @(
    "DEVNET_ADMIN_PRIVATE_KEY",
    "DEVNET_VAULT_ADMIN_PRIVATE_KEY",
    "DEVNET_TRADER_A_PRIVATE_KEY",
    "DEVNET_TRADER_B_PRIVATE_KEY",
    "DEVNET_ATTESTER_PRIVATE_KEY",
    "DEVNET_LEDGER_ROOT_A",
    "DEVNET_LEDGER_ROOT_B",
    "DEVNET_TRADE_START_BLOCK_A",
    "DEVNET_TRADE_END_BLOCK_A",
    "DEVNET_TRADE_START_BLOCK_B",
    "DEVNET_TRADE_END_BLOCK_B",
    "DEVNET_TRADE_START_BLOCK_L2_A",
    "DEVNET_TRADE_END_BLOCK_L2_A",
    "DEVNET_TRADE_START_BLOCK_L2_B",
    "DEVNET_TRADE_END_BLOCK_L2_B",
    "DEVNET_CASH_START_A",
    "DEVNET_CASH_END_A",
    "DEVNET_CASH_START_B",
    "DEVNET_CASH_END_B"
)

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

function Get-LocalPrivateKey {
    param([int]$Index)

    $key = (& cast wallet private-key $Mnemonic $Index).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $key.StartsWith("0x")) {
        throw "Unable to derive local-only account index $Index"
    }
    return $key
}

function Convert-HexToBigInteger {
    param([Parameter(Mandatory = $true)]$Value)

    $text = [string]$Value
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

function Get-ReceiptSummary {
    param(
        [Parameter(Mandatory = $true)]$Transaction,
        [Parameter(Mandatory = $true)]$Receipt
    )

    $logsJson = @($Receipt.logs) | ConvertTo-Json -Depth 30 -Compress
    $logsHash = (& cast keccak $logsJson).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to hash logs for transaction $($Receipt.transactionHash)"
    }

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
            throw "Failed transaction $($receipt.transactionHash) in $Path"
        }
        if ([string]::IsNullOrWhiteSpace([string]$receipt.transactionHash) -or
            [string]::IsNullOrWhiteSpace([string]$receipt.blockHash)) {
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
            throw "No receipt for $hash in $Path"
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
        [Parameter(Mandatory = $true)]$Broadcast,
        [Parameter(Mandatory = $true)][string]$From,
        [Parameter(Mandatory = $true)][string]$FunctionPrefix
    )

    $matches = @($Broadcast.transactions | Where-Object {
        ([string]$_.transaction.from).ToLowerInvariant() -eq $From.ToLowerInvariant() -and
        ([string]$_.function).StartsWith($FunctionPrefix)
    })
    if ($matches.Count -ne 1) {
        throw "Expected one $FunctionPrefix transaction from $From, found $($matches.Count)"
    }

    $hash = ([string]$matches[0].hash).ToLowerInvariant()
    $receipt = @($Broadcast.receipts | Where-Object {
        ([string]$_.transactionHash).ToLowerInvariant() -eq $hash
    })
    if ($receipt.Count -ne 1) {
        throw "Expected one receipt for $hash"
    }
    return Get-ReceiptSummary -Transaction $matches[0] -Receipt $receipt[0]
}

function Get-TokenBalance {
    param(
        [Parameter(Mandatory = $true)][string]$Token,
        [Parameter(Mandatory = $true)][string]$Account,
        [Parameter(Mandatory = $true)][string]$Block
    )

    $balance = (& cast erc20 balance $Token $Account --block $Block --rpc-url $RpcUrl).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to read token balance for $Account at block $Block"
    }
    return Convert-HexToBigInteger $balance
}

function Get-NativeBalance {
    param(
        [Parameter(Mandatory = $true)][string]$Account,
        [Parameter(Mandatory = $true)][string]$Block
    )

    $balance = (& cast balance $Account --block $Block --rpc-url $RpcUrl).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to read native balance for $Account at block $Block"
    }
    return Convert-HexToBigInteger $balance
}

function New-TraderEvidence {
    param(
        [Parameter(Mandatory = $true)]$Broadcast,
        [Parameter(Mandatory = $true)][string]$Account,
        [Parameter(Mandatory = $true)][string]$Weth,
        [Parameter(Mandatory = $true)][string]$Stock,
        [Parameter(Mandatory = $true)][string]$Market,
        [Parameter(Mandatory = $true)][int]$SavingsBps,
        [Parameter(Mandatory = $true)][string]$GrossProfitWei,
        [Parameter(Mandatory = $true)][int]$L2LaneOffset
    )

    $buy = Find-TransactionReceipt -Broadcast $Broadcast -From $Account -FunctionPrefix "buy("
    $approve = Find-TransactionReceipt -Broadcast $Broadcast -From $Account -FunctionPrefix "approve("
    $sell = Find-TransactionReceipt -Broadcast $Broadcast -From $Account -FunctionPrefix "sell("
    $startBlock = [System.Numerics.BigInteger]::Parse($buy.blockNumber)
    $endBlock = [System.Numerics.BigInteger]::Parse($sell.blockNumber)
    $preTradeBlock = $startBlock - [System.Numerics.BigInteger]::One

    # Anvil has ONE block counter, so `block.number` is the L1 clock and there is
    # no observed L2 height to read. The L2 window is therefore modelled, exactly
    # as test/e2e/DevnetTradingDrill.t.sol:249-253 models it, and by the same
    # formula so the in-process rehearsal and the broadcast run describe the same
    # windows. Each trader gets its own lane off the shared L1 block, which makes
    # the two windows DISJOINT in L2 while they overlap in L1 — the production
    # relationship, and the case the L2 progression rule exists for.
    # These values are modelled, not observed, so they stay out of the receipt
    # ledger below: that ledger records what the chain showed, nothing else.
    $startBlockL2 = $startBlock * 1000 + [System.Numerics.BigInteger]$L2LaneOffset
    $endBlockL2 = $startBlockL2 + 400

    $nativeStart = Get-NativeBalance -Account $Account -Block $preTradeBlock.ToString()
    $wethStart = Get-TokenBalance -Token $Weth -Account $Account -Block $preTradeBlock.ToString()
    $nativeEnd = Get-NativeBalance -Account $Account -Block $endBlock.ToString()
    $wethEnd = Get-TokenBalance -Token $Weth -Account $Account -Block $endBlock.ToString()
    $cashStart = $nativeStart + $wethStart
    $cashEnd = $nativeEnd + $wethEnd
    if ($cashEnd -le $cashStart) {
        throw "Trader $Account did not realize positive net PnL after gas"
    }
    $profit = $cashEnd - $cashStart
    $totalTradingGasCost =
        [System.Numerics.BigInteger]::Parse($buy.gasCostWei) +
        [System.Numerics.BigInteger]::Parse($approve.gasCostWei) +
        [System.Numerics.BigInteger]::Parse($sell.gasCostWei)
    $grossProfit = [System.Numerics.BigInteger]::Parse($GrossProfitWei)
    if ($profit -ne $grossProfit - $totalTradingGasCost) {
        throw "Gas-inclusive PnL reconciliation failed for $Account"
    }
    $contribution = ($profit * $SavingsBps) / 10000

    $canonical = [ordered]@{
        schema = "nuvem.devnet.receipt-ledger.v1"
        chainId = "$ChainId"
        account = $Account.ToLowerInvariant()
        nativeToken = "0x0000000000000000000000000000000000000000"
        weth = $Weth.ToLowerInvariant()
        stock = $Stock.ToLowerInvariant()
        market = $Market.ToLowerInvariant()
        startBlock = $startBlock.ToString()
        endBlock = $endBlock.ToString()
        cashStartNativePlusWeth = $cashStart.ToString()
        cashEndNativePlusWeth = $cashEnd.ToString()
        grossRealizedProfitBeforeGas = $grossProfit.ToString()
        totalTradingGasCostWei = $totalTradingGasCost.ToString()
        netRealizedProfitAfterGas = $profit.ToString()
        externalDeposits = "0"
        externalWithdrawals = "0"
        faucetClassification = "pre-session funding"
        transactions = @($buy, $approve, $sell)
    }
    $canonicalJson = $canonical | ConvertTo-Json -Depth 40 -Compress
    $ledgerRoot = (& cast keccak $canonicalJson).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $ledgerRoot.StartsWith("0x")) {
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
        startBlock = $startBlock.ToString()
        endBlock = $endBlock.ToString()
        startBlockL2 = $startBlockL2.ToString()
        endBlockL2 = $endBlockL2.ToString()
        canonicalLedger = $canonical
    }
}

try {
    foreach ($tool in @("anvil", "cast", "forge")) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            throw "Required executable not found: $tool"
        }
    }

    try {
        & cast chain-id --rpc-url $RpcUrl *> $null
        if ($LASTEXITCODE -eq 0) {
            throw "RPC port $Port is already in use; refusing to reuse unknown chain state"
        }
    } catch {
        if ($_.Exception.Message -like "RPC port*") {
            throw
        }
    }

    if (-not (Test-Path -LiteralPath $DeploymentsDir)) {
        New-Item -ItemType Directory -Path $DeploymentsDir | Out-Null
    }

    $anvilStdout = Join-Path $DeploymentsDir "devnet-trading-drill-anvil.stdout.log"
    $anvilStderr = Join-Path $DeploymentsDir "devnet-trading-drill-anvil.stderr.log"
    $anvilExecutable = (Get-Command anvil).Source
    $anvilArguments = @(
        "--port", "$Port",
        "--chain-id", "$ChainId",
        "--accounts", "3",
        "--balance", "1000",
        "--mnemonic", ('"' + $Mnemonic + '"'),
        "--silent"
    )
    $anvilStartParameters = @{
        FilePath = $anvilExecutable
        ArgumentList = $anvilArguments
        WorkingDirectory = $ContractsRoot
        RedirectStandardOutput = $anvilStdout
        RedirectStandardError = $anvilStderr
        PassThru = $true
    }
    # -WindowStyle is a Windows-only parameter: PowerShell 7 on macOS and Linux
    # REJECTS it outright rather than ignoring it, which stopped this script before
    # it ever reached anvil. There is no window to hide off Windows anyway — anvil
    # runs --silent with both streams already redirected to the log files above.
    # The 5.1 check comes first so the -or short-circuits before $IsWindows, which
    # does not exist on 5.1 and would trip Set-StrictMode.
    if ($PSVersionTable.PSVersion.Major -lt 6 -or $IsWindows) {
        $anvilStartParameters.WindowStyle = "Hidden"
    }
    $AnvilProcess = Start-Process @anvilStartParameters

    $ready = $false
    for ($attempt = 0; $attempt -lt 80; $attempt++) {
        Start-Sleep -Milliseconds 250
        & cast chain-id --rpc-url $RpcUrl *> $null
        if ($LASTEXITCODE -eq 0) {
            $ready = $true
            break
        }
        if ($AnvilProcess.HasExited) {
            throw "Anvil exited before the RPC became ready; inspect $anvilStderr"
        }
    }
    if (-not $ready) {
        throw "Anvil RPC did not become ready at $RpcUrl"
    }

    $env:DEVNET_ADMIN_PRIVATE_KEY = Get-LocalPrivateKey 0
    $env:DEVNET_VAULT_ADMIN_PRIVATE_KEY = Get-LocalPrivateKey 5
    $env:DEVNET_TRADER_A_PRIVATE_KEY = Get-LocalPrivateKey 6
    $env:DEVNET_TRADER_B_PRIVATE_KEY = Get-LocalPrivateKey 7
    $env:DEVNET_ATTESTER_PRIVATE_KEY = Get-LocalPrivateKey 8

    Push-Location $ContractsRoot
    try {
        Invoke-Checked forge test --match-path "test/e2e/DevnetTradingDrill.t.sol" -vv

        Invoke-Checked forge script "script/DeployDevnetDrill.s.sol:DeployDevnetDrill" `
            --rpc-url $RpcUrl --broadcast --slow -vv
        $setupBroadcastPath = Join-Path $ContractsRoot "broadcast/DeployDevnetDrill.s.sol/$ChainId/run-latest.json"
        $setupBroadcast = Read-VerifiedBroadcast $setupBroadcastPath

        $deploymentPath = Join-Path $DeploymentsDir "devnet-trading-drill-$ChainId.local.json"
        $deployment = Get-Content -Raw -LiteralPath $deploymentPath | ConvertFrom-Json

        Invoke-Checked forge script "script/ExecuteDevnetTrades.s.sol:ExecuteDevnetTrades" `
            --rpc-url $RpcUrl --broadcast --slow -vv
        $tradeBroadcastPath = Join-Path $ContractsRoot "broadcast/ExecuteDevnetTrades.s.sol/$ChainId/run-latest.json"
        $tradeBroadcast = Read-VerifiedBroadcast $tradeBroadcastPath

        $evidenceA = New-TraderEvidence `
            -Broadcast $tradeBroadcast `
            -Account ([string]$deployment.traderA) `
            -Weth ([string]$deployment.weth) `
            -Stock ([string]$deployment.stock) `
            -Market ([string]$deployment.market) `
            -SavingsBps 2000 `
            -GrossProfitWei "2000000000000000000" `
            -L2LaneOffset 0
        $evidenceB = New-TraderEvidence `
            -Broadcast $tradeBroadcast `
            -Account ([string]$deployment.traderB) `
            -Weth ([string]$deployment.weth) `
            -Stock ([string]$deployment.stock) `
            -Market ([string]$deployment.market) `
            -SavingsBps 3000 `
            -GrossProfitWei "1000000000000000000" `
            -L2LaneOffset 500

        $env:DEVNET_LEDGER_ROOT_A = $evidenceA.ledgerRoot
        $env:DEVNET_LEDGER_ROOT_B = $evidenceB.ledgerRoot
        $env:DEVNET_TRADE_START_BLOCK_A = $evidenceA.startBlock
        $env:DEVNET_TRADE_END_BLOCK_A = $evidenceA.endBlock
        $env:DEVNET_TRADE_START_BLOCK_B = $evidenceB.startBlock
        $env:DEVNET_TRADE_END_BLOCK_B = $evidenceB.endBlock
        $env:DEVNET_TRADE_START_BLOCK_L2_A = $evidenceA.startBlockL2
        $env:DEVNET_TRADE_END_BLOCK_L2_A = $evidenceA.endBlockL2
        $env:DEVNET_TRADE_START_BLOCK_L2_B = $evidenceB.startBlockL2
        $env:DEVNET_TRADE_END_BLOCK_L2_B = $evidenceB.endBlockL2
        $env:DEVNET_CASH_START_A = $evidenceA.cashStart
        $env:DEVNET_CASH_END_A = $evidenceA.cashEnd
        $env:DEVNET_CASH_START_B = $evidenceB.cashStart
        $env:DEVNET_CASH_END_B = $evidenceB.cashEnd

        $receiptEvidencePath = Join-Path $DeploymentsDir "devnet-trading-drill-receipts-$ChainId.local.json"
        $receiptEvidence = [ordered]@{
            schema = "nuvem.devnet.drill-evidence.v1"
            chainId = $ChainId
            rpc = $RpcUrl
            setupTransactionCount = $setupBroadcast.transactionCount
            traderA = $evidenceA
            traderB = $evidenceB
        }
        $receiptEvidence | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $receiptEvidencePath -Encoding UTF8

        Invoke-Checked forge script "script/SettleDevnetDrill.s.sol:SettleDevnetDrill" `
            --rpc-url $RpcUrl --broadcast --slow -vv
        $settlementBroadcastPath = Join-Path $ContractsRoot "broadcast/SettleDevnetDrill.s.sol/$ChainId/run-latest.json"
        $settlementBroadcast = Read-VerifiedBroadcast $settlementBroadcastPath

        Invoke-Checked forge script "script/VerifyDevnetTradingDrill.s.sol:VerifyDevnetTradingDrill" `
            --rpc-url $RpcUrl -vv

        $resultsPath = Join-Path $DeploymentsDir "devnet-trading-drill-results-$ChainId.local.json"
        $results = Get-Content -Raw -LiteralPath $resultsPath | ConvertFrom-Json
        if ([string]$results.status -ne "verified") {
            throw "Post-broadcast verification did not produce verified status"
        }

        $broadcastEvidencePath = Join-Path $DeploymentsDir "devnet-trading-drill-broadcasts-$ChainId.local.json"
        $broadcastEvidence = [ordered]@{
            schema = "nuvem.devnet.broadcast-evidence.v1"
            chainId = $ChainId
            status = "verified"
            setup = $setupBroadcast.summaries
            trades = $tradeBroadcast.summaries
            settlement = $settlementBroadcast.summaries
        }
        $broadcastEvidence | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $broadcastEvidencePath -Encoding UTF8

        Write-Host "Nuvem devnet trading drill: VERIFIED"
        Write-Host "RPC: $RpcUrl"
        Write-Host "Deployment: $deploymentPath"
        Write-Host "Receipt ledger evidence: $receiptEvidencePath"
        Write-Host "Broadcast receipt evidence: $broadcastEvidencePath"
        Write-Host "Final state: $resultsPath"
    } finally {
        Pop-Location
    }
} finally {
    foreach ($name in $EnvironmentNames) {
        Remove-Item "Env:\$name" -ErrorAction SilentlyContinue
    }
    if ($null -ne $AnvilProcess -and -not $KeepAnvil -and -not $AnvilProcess.HasExited) {
        Stop-Process -Id $AnvilProcess.Id
        $AnvilProcess.WaitForExit()
    } elseif ($null -ne $AnvilProcess -and $KeepAnvil -and -not $AnvilProcess.HasExited) {
        Write-Host "Anvil left running (PID $($AnvilProcess.Id)) at $RpcUrl"
    }
}
