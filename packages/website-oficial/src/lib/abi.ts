/**
 * Narrow, `as const` ABI fragments for exactly the functions and events the
 * wallets wave uses. Ported from the Nuvem dashboard's src/lib/abi.ts (HEAD
 * fd927b0), regenerated from @nuvem/contracts-artifacts for this build.
 *
 * WHY NOT `import { abis } from '@nuvem/contracts-artifacts'` DIRECTLY?
 * Two reasons, both real:
 *   1. That module is typed `Abi`, not a literal type, so viem loses all return
 *      inference — `getTradingAccount` would come back as `unknown` and every
 *      read would be built on a cast. Casts are exactly how a page starts lying
 *      about onchain state.
 *   2. It also carries deployment and deployed bytecode for every contract,
 *      which has no business in a browser bundle.
 *
 * These fragments are therefore COPIED from @nuvem/contracts-artifacts, and
 * `scripts/check-abis.mts` deep-compares every entry below against that package
 * (ignoring only `internalType`). If that check fails, re-copy from the
 * artifacts — do not "fix" it by editing the check.
 *
 * THE ERRORS ARE NOT DECORATION. viem only names a revert it can decode, and it
 * decodes against the ABI it is handed: with the error fragments present,
 * simulateContract reports `VaultAdminAlreadyRegistered(address,address)` by
 * name; without them the same revert is an opaque hex blob. Every action on the
 * wallets page shows the named reason, so both contracts' errors travel with
 * their functions.
 *
 * Sources: packages/contracts/src/{factory/VaultFactory,vault/PersonalVault}.sol
 */

export const vaultFactoryAbi = [
  {
    "type": "function",
    "name": "createVault",
    "inputs": [
      {
        "name": "userSalt",
        "type": "bytes32"
      },
      {
        "name": "cohortId",
        "type": "uint32"
      },
      {
        "name": "initData",
        "type": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "vaultId",
        "type": "bytes32"
      },
      {
        "name": "vault",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "predictVault",
    "inputs": [
      {
        "name": "vaultAdmin",
        "type": "address"
      },
      {
        "name": "userSalt",
        "type": "bytes32"
      },
      {
        "name": "cohortId",
        "type": "uint32"
      },
      {
        "name": "initData",
        "type": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "vaultId",
        "type": "bytes32"
      },
      {
        "name": "predicted",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "vaultOfAdmin",
    "inputs": [
      {
        "name": "vaultAdmin",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "vault",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "activeVaultOf",
    "inputs": [
      {
        "name": "tradingAccount",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "vault",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "protocolConfiguration",
    "inputs": [],
    "outputs": [
      {
        "name": "weth",
        "type": "address"
      },
      {
        "name": "pauseController",
        "type": "address"
      },
      {
        "name": "attesterRegistry",
        "type": "address"
      },
      {
        "name": "settlementExecutor",
        "type": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "cohorts",
    "inputs": [
      {
        "name": "cohortId",
        "type": "uint32"
      }
    ],
    "outputs": [
      {
        "name": "beacon",
        "type": "address"
      },
      {
        "name": "initialImplementation",
        "type": "address"
      },
      {
        "name": "upgradeAuthority",
        "type": "address"
      },
      {
        "name": "registeredAtBlock",
        "type": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "error",
    "name": "CallerNotRegisteredVault",
    "inputs": [
      {
        "name": "caller",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "CohortIdOverflow",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidCohort",
    "inputs": [
      {
        "name": "cohortId",
        "type": "uint32"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidShortString",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidVaultAdminSignature",
    "inputs": [
      {
        "name": "vaultAdmin",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotAContract",
    "inputs": [
      {
        "name": "account",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "OwnableInvalidOwner",
    "inputs": [
      {
        "name": "owner",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "OwnableUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ProtocolAlreadyConfigured",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RenounceDisabled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SignatureExpired",
    "inputs": [
      {
        "name": "deadline",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "StringTooLong",
    "inputs": [
      {
        "name": "str",
        "type": "string"
      }
    ]
  },
  {
    "type": "error",
    "name": "TradingAccountAlreadyLinked",
    "inputs": [
      {
        "name": "tradingAccount",
        "type": "address"
      },
      {
        "name": "activeVault",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "TradingAccountNotLinkedToCaller",
    "inputs": [
      {
        "name": "tradingAccount",
        "type": "address"
      },
      {
        "name": "activeVault",
        "type": "address"
      },
      {
        "name": "caller",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "UnexpectedVaultAddress",
    "inputs": [
      {
        "name": "expected",
        "type": "address"
      },
      {
        "name": "actual",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "VaultAddressAlreadyRegistered",
    "inputs": [
      {
        "name": "vault",
        "type": "address"
      },
      {
        "name": "vaultId",
        "type": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "VaultAdminAlreadyRegistered",
    "inputs": [
      {
        "name": "vaultAdmin",
        "type": "address"
      },
      {
        "name": "vault",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "VaultAdminCannotBeTradingAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address"
      },
      {
        "name": "vault",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "VaultAdminNotLinkedToCaller",
    "inputs": [
      {
        "name": "vaultAdmin",
        "type": "address"
      },
      {
        "name": "linkedVault",
        "type": "address"
      },
      {
        "name": "caller",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "VaultAlreadyExists",
    "inputs": [
      {
        "name": "vaultId",
        "type": "bytes32"
      },
      {
        "name": "vault",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;

export const personalVaultAbi = [
  {
    "type": "function",
    "name": "vaultId",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "inviteTradingAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address"
      },
      {
        "name": "platformId",
        "type": "bytes32"
      },
      {
        "name": "policy",
        "type": "tuple",
        "components": [
          {
            "name": "savingsBps",
            "type": "uint16"
          },
          {
            "name": "minContributionWei",
            "type": "uint128"
          },
          {
            "name": "maxPerSettlementWei",
            "type": "uint128"
          },
          {
            "name": "maxRolling30dWei",
            "type": "uint128"
          },
          {
            "name": "tradingFloorWei",
            "type": "uint128"
          },
          {
            "name": "gasReserveWei",
            "type": "uint128"
          }
        ]
      },
      {
        "name": "deadline",
        "type": "uint48"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "acceptTradingAccountBySig",
    "inputs": [
      {
        "name": "account",
        "type": "address"
      },
      {
        "name": "deadline",
        "type": "uint48"
      },
      {
        "name": "signature",
        "type": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getTradingAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "components": [
          {
            "name": "status",
            "type": "uint8"
          },
          {
            "name": "platformId",
            "type": "bytes32"
          },
          {
            "name": "bindingEpoch",
            "type": "uint64"
          },
          {
            "name": "policyNonce",
            "type": "uint64"
          },
          {
            "name": "inviteNonce",
            "type": "uint64"
          },
          {
            "name": "inviteAdminEpoch",
            "type": "uint64"
          },
          {
            "name": "settlementNonce",
            "type": "uint64"
          },
          {
            "name": "activationBlock",
            "type": "uint64"
          },
          {
            "name": "revocationBlock",
            "type": "uint64"
          },
          {
            "name": "inviteDeadline",
            "type": "uint48"
          },
          {
            "name": "policy",
            "type": "tuple",
            "components": [
              {
                "name": "savingsBps",
                "type": "uint16"
              },
              {
                "name": "minContributionWei",
                "type": "uint128"
              },
              {
                "name": "maxPerSettlementWei",
                "type": "uint128"
              },
              {
                "name": "maxRolling30dWei",
                "type": "uint128"
              },
              {
                "name": "tradingFloorWei",
                "type": "uint128"
              },
              {
                "name": "gasReserveWei",
                "type": "uint128"
              }
            ]
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setMySavingsBps",
    "inputs": [
      {
        "name": "nextSavingsBps",
        "type": "uint16"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setTradingAccountPolicy",
    "inputs": [
      {
        "name": "account",
        "type": "address"
      },
      {
        "name": "policy",
        "type": "tuple",
        "components": [
          {
            "name": "savingsBps",
            "type": "uint16"
          },
          {
            "name": "minContributionWei",
            "type": "uint128"
          },
          {
            "name": "maxPerSettlementWei",
            "type": "uint128"
          },
          {
            "name": "maxRolling30dWei",
            "type": "uint128"
          },
          {
            "name": "tradingFloorWei",
            "type": "uint128"
          },
          {
            "name": "gasReserveWei",
            "type": "uint128"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revokeMyTradingAccount",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "activeTradingAccountCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "error",
    "name": "AccountAlreadyLinked",
    "inputs": [
      {
        "name": "account",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "AccountNotActive",
    "inputs": [
      {
        "name": "account",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "DeadlineExpired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InsufficientInvestmentOutput",
    "inputs": [
      {
        "name": "targetAsset",
        "type": "address"
      },
      {
        "name": "required",
        "type": "uint256"
      },
      {
        "name": "received",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidInitialization",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidInvestmentPolicyNonce",
    "inputs": [
      {
        "name": "expected",
        "type": "uint64"
      },
      {
        "name": "actual",
        "type": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidPercentage",
    "inputs": [
      {
        "name": "savingsBps",
        "type": "uint16"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidPolicy",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidSettlement",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidState",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvestmentAboveCeiling",
    "inputs": [
      {
        "name": "amountIn",
        "type": "uint256"
      },
      {
        "name": "maxPerCallWei",
        "type": "uint128"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvestmentBasketMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvestmentBelowThreshold",
    "inputs": [
      {
        "name": "amountIn",
        "type": "uint256"
      },
      {
        "name": "minInvestmentWei",
        "type": "uint128"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvestmentDisabled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvestmentIsPaused",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NonProgressiveBlockRange",
    "inputs": [
      {
        "name": "previousEndBlock",
        "type": "uint64"
      },
      {
        "name": "startBlock",
        "type": "uint64"
      },
      {
        "name": "endBlock",
        "type": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "NonProgressiveL1BlockRange",
    "inputs": [
      {
        "name": "previousEndBlock",
        "type": "uint64"
      },
      {
        "name": "startBlock",
        "type": "uint64"
      },
      {
        "name": "endBlock",
        "type": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotAContract",
    "inputs": [
      {
        "name": "account",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotInitializing",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ProtocolPaused",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RollingCapExceeded",
    "inputs": [
      {
        "name": "cap",
        "type": "uint128"
      },
      {
        "name": "spent",
        "type": "uint128"
      },
      {
        "name": "requested",
        "type": "uint128"
      }
    ]
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "SessionAlreadyUsed",
    "inputs": [
      {
        "name": "sessionId",
        "type": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "Unauthorized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;

/**
 * The three PersonalVault events a trading wallet's life leaves behind. There
 * is NO view function that enumerates a vault's accounts — the contract keeps
 * a mapping and a counter — so the list on the wallets page is the union of
 * these logs since NUVEM_LOGS_FROM_BLOCK, deduplicated by address, with each
 * address's CURRENT status then read from getTradingAccount. Invited covers an
 * invite never accepted (PENDING); Activated covers an acceptance whose invite
 * predates the scan window; Revoked covers an account whose whole history
 * predates it. All three index `account` first, so one eth_getLogs with an
 * OR of the three topics returns everything.
 */
export const tradingAccountInvitedEvent = {
  "type": "event",
  "name": "TradingAccountInvited",
  "inputs": [
    {
      "name": "account",
      "type": "address",
      "indexed": true
    },
    {
      "name": "platformId",
      "type": "bytes32",
      "indexed": true
    },
    {
      "name": "savingsBps",
      "type": "uint16",
      "indexed": false
    },
    {
      "name": "inviteNonce",
      "type": "uint64",
      "indexed": false
    },
    {
      "name": "deadline",
      "type": "uint48",
      "indexed": false
    }
  ],
  "anonymous": false
} as const;

export const tradingAccountActivatedEvent = {
  "type": "event",
  "name": "TradingAccountActivated",
  "inputs": [
    {
      "name": "account",
      "type": "address",
      "indexed": true
    },
    {
      "name": "platformId",
      "type": "bytes32",
      "indexed": true
    },
    {
      "name": "bindingEpoch",
      "type": "uint64",
      "indexed": false
    },
    {
      "name": "activationBlock",
      "type": "uint64",
      "indexed": false
    }
  ],
  "anonymous": false
} as const;

export const tradingAccountRevokedEvent = {
  "type": "event",
  "name": "TradingAccountRevoked",
  "inputs": [
    {
      "name": "account",
      "type": "address",
      "indexed": true
    },
    {
      "name": "bindingEpoch",
      "type": "uint64",
      "indexed": false
    },
    {
      "name": "revocationBlock",
      "type": "uint64",
      "indexed": false
    }
  ],
  "anonymous": false
} as const;

/**
 * The tuple accepted by PersonalVault.initialize via
 * VaultFactory.createVault(userSalt, cohortId, initData).
 *
 * initData is `abi.encode(NuvemTypes.VaultInitialization)`. The four component
 * addresses are NOT free: PersonalVault._validateInitialization requires
 * `factory.isProtocolConfiguration(...)` to accept them
 * (packages/contracts/src/vault/PersonalVault.sol), which is why the
 * create-vault route builds initData from VaultFactory.protocolConfiguration()
 * read onchain rather than from environment variables.
 *
 * THIS IS THE MOST DANGEROUS FRAGMENT IN THE FILE, because `initData` is typed
 * `bytes` in the published ABI. `initialize` therefore keeps its selector no
 * matter how VaultInitialization is reshaped, and a stale encoding here produces
 * no type error and no selector mismatch — it produces a confusing
 * `InvalidPolicy` revert at vault creation, or worse, a vault built from
 * misaligned words. Nothing in the compiled ABI describes this tuple directly,
 * so scripts/check-abis.mts reconstructs it from two published fragments that
 * the contract itself derives it from:
 *   - the first four components must equal the INPUTS of
 *     `VaultFactory.isProtocolConfiguration`, which is the exact argument list
 *     _validateInitialization passes them to, in order; and
 *   - `policy` must equal the OUTPUT tuple of `VaultLens.getVaultPolicy`,
 *     which returns the same NuvemTypes.VaultPolicy this field carries.
 * Keep those two facts true of the contracts, or replace the guard — do not
 * weaken it.
 */
export const vaultInitializationParam = {
  type: "tuple",
  name: "initialization",
  components: [
    { name: "weth", type: "address" },
    { name: "pauseController", type: "address" },
    { name: "attesterRegistry", type: "address" },
    { name: "settlementExecutor", type: "address" },
    {
      name: "policy",
      type: "tuple",
      components: [{ name: "maxAggregateRolling30dWei", type: "uint128" }],
    },
  ],
} as const;

/** NuvemTypes.AccountStatus. Index order is load-bearing: the ABI returns uint8. */
export const ACCOUNT_STATUS = ["NONE", "PENDING", "ACTIVE", "PAUSED", "REVOKED"] as const;
export type AccountStatusName = (typeof ACCOUNT_STATUS)[number];
export const ACCOUNT_STATUS_ACTIVE = 2;

/** NuvemTypes.BPS_DENOMINATOR */
export const BPS_DENOMINATOR = 10_000;
