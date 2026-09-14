"use client";

import { Copy, ExternalLink, LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Num } from "@/components/num";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { shortHex } from "@/lib/format";
import type { Wallet } from "@/mocks";

/**
 * The header's wallet control. MOCK: the connect state is local and starts
 * connected, because the page is already showing this wallet's data — a
 * "Connect" button beside it would contradict everything else on screen.
 * Disconnecting changes nothing but this button; connecting flips it back.
 */
export function WalletMenu({ wallet }: { wallet: Wallet }) {
  const [connected, setConnected] = useState(true);

  // Connect and Disconnect each swap the root element, so the focused button
  // unmounts and Radix refocuses a trigger that no longer exists — a keyboard
  // user lands on <body>. Hand focus to whichever button took the old one's
  // place, but only after a toggle, never on first render.
  const buttonRef = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);
  useEffect(() => {
    if (toggled.current) buttonRef.current?.focus();
  }, [connected]);

  if (!connected) {
    return (
      <Button
        ref={buttonRef}
        size="sm"
        onClick={() => {
          toggled.current = true;
          setConnected(true);
        }}
      >
        Connect wallet
      </Button>
    );
  }

  // The address's first two characters, uppercase — a stable mark for this address.
  const initials = wallet.address.slice(0, 2).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={buttonRef} variant="outline" size="sm" className="gap-2">
          <Avatar className="size-5">
            <AvatarFallback className="font-mono text-[10px]">{initials}</AvatarFallback>
          </Avatar>
          <Num>{shortHex(wallet.address)}</Num>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{wallet.label}</span>
          <span className="font-normal">{wallet.network}</span>
        </DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() => {
            // Inside the handler only: there is no navigator during render on the server.
            void navigator.clipboard?.writeText(wallet.address).catch(() => {});
          }}
        >
          <Copy aria-hidden />
          Copy address
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href="#">
            <ExternalLink aria-hidden />
            View on explorer
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            toggled.current = true;
            setConnected(false);
          }}
        >
          <LogOut aria-hidden />
          Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
