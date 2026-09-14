export declare const DEFAULT_PUBLIC_WS_URL: "wss://api.mainnet-beta.solana.com";

export type PublicWsUrlCheck =
  | { readonly ok: true; readonly url: string; readonly defaulted: boolean }
  | { readonly ok: false; readonly reason: string };

export declare function checkPublicWsUrl(raw: string | undefined, rpcUrls: readonly string[]): PublicWsUrlCheck;
