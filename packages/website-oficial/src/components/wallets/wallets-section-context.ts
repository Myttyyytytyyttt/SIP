"use client";

/**
 * THE WAY ACROSS THE TABS. A card in one tab can send the person to another:
 * the trading wallets card's "create your vault" after a press that stopped for
 * want of one, and the overview's next steps. With every area on one long page
 * that was an anchor (#vault) and a scroll; in tabs the target sits in a hidden
 * panel and an anchor goes nowhere, and seat-activity.ts cancels every a[href]
 * click while a re-seat runs besides. So WalletsScreen hands its tab switch down
 * through this context, and a card that finds it switches tabs with a button.
 *
 * null outside the tabbed screen: a card rendered on its own keeps its old way
 * (the anchor), so nothing changes for it.
 */

import { createContext } from "react";

import type { WalletsSection } from "@/lib/wallets-sections";

export const WalletsSectionContext = createContext<((section: WalletsSection) => void) | null>(null);
