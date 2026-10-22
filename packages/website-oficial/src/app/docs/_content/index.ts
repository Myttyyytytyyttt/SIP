/**
 * EVERY PAGE'S BODY, BY ITS SLUG: what src/app/docs/[slug]/page.tsx draws under
 * the title and the clip. A Record over every slug, so a page added to the index
 * (src/lib/docs/pages.ts) without a body here fails to compile.
 *
 * A PRIVATE FOLDER (the leading underscore): Next never routes it, so
 * /docs/_content is a 404 like any other address that is not a page.
 */

import type { ComponentType } from "react";

import type { DocSlug } from "@/lib/docs/pages";

import WhatIsSaverfiBody from "./what-is-saverfi";
import PensionKeyBody from "./pension-key";
import SavingFromProfitBody from "./saving-from-profit";
import SavingFromVolumeBody from "./saving-from-volume";
import RoundUpsBody from "./round-ups";
import TimingAndLimitsBody from "./timing-and-limits";
import CreateYourVaultBody from "./create-your-vault";
import TradingWalletsBody from "./trading-wallets";
import ImportAWalletBody from "./import-a-wallet";
import InvestingBody from "./investing";
import DashboardBody from "./dashboard";
import ChangeSettingsBody from "./change-settings";
import TakeMoneyOutBody from "./take-money-out";
import NotSavingBody from "./not-saving";
import PublicPagesBody from "./public-pages";
import FeesBody from "./fees";
import WhoControlsWhatBody from "./who-controls-what";
import RisksAndBetaBody from "./risks-and-beta";

export const DOC_CONTENT: Readonly<Record<DocSlug, ComponentType>> = {
  "what-is-saverfi": WhatIsSaverfiBody,
  "pension-key": PensionKeyBody,
  "saving-from-profit": SavingFromProfitBody,
  "saving-from-volume": SavingFromVolumeBody,
  "round-ups": RoundUpsBody,
  "timing-and-limits": TimingAndLimitsBody,
  "create-your-vault": CreateYourVaultBody,
  "trading-wallets": TradingWalletsBody,
  "import-a-wallet": ImportAWalletBody,
  "investing": InvestingBody,
  "dashboard": DashboardBody,
  "change-settings": ChangeSettingsBody,
  "take-money-out": TakeMoneyOutBody,
  "not-saving": NotSavingBody,
  "public-pages": PublicPagesBody,
  "fees": FeesBody,
  "who-controls-what": WhoControlsWhatBody,
  "risks-and-beta": RisksAndBetaBody,
};
