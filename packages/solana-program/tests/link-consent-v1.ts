// The SIP_LINK_V1 consent bytes, pinned. The unit test in link_consent.rs holds
// the same vector, and neither mirror produced it: it was computed with Python
// from the inputs below. If the web, the scripts or the program drifts by one
// byte, a wallet's consent stops verifying and nobody can link; this fails first.

import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { LINK_CONSENT_DOMAIN, LINK_CONSENT_MESSAGE_LEN, linkConsentMessage } from "../scripts/link-consent";

const GOLDEN_V1_HEX =
  "ff5349505f4c494e4b5f56310101010101010101010101010101010101010101010101010101010101010101020202020202020202020202020202020202020202020202020202020202020203030303030303030303030303030303030303030303030303030303030303030404040404040404040404040404040404040404040404040404040404040404";

describe("link consent V1 bytes", () => {
  it("the TypeScript mirror matches the golden vector byte for byte", () => {
    const key = (byte: number) => new PublicKey(Buffer.alloc(32, byte));
    const message = linkConsentMessage({ programId: key(1), wallet: key(2), vault: key(3), owner: key(4) });
    assert.strictEqual(LINK_CONSENT_DOMAIN.length, 12);
    assert.strictEqual(LINK_CONSENT_MESSAGE_LEN, 140);
    assert.strictEqual(message.length, LINK_CONSENT_MESSAGE_LEN);
    assert.strictEqual(message[0], 0xff, "the lead byte no transaction message can start with");
    assert.strictEqual(message.toString("hex"), GOLDEN_V1_HEX);
  });
});
