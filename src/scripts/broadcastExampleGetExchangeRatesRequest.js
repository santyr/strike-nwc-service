const { encrypt } = require("nostr-tools/nip04");
const {
  NWC_CONNECTION_SECRET,
  NWC_SERVICE_PUBKEY,
  RELAY_URI,
} = require("../constants");
const { NWCWalletRequest } = require("nostr-tools/kinds");
const { finalizeEvent } = require("nostr-tools/pure");
const { Relay, useWebSocketImplementation } = require("nostr-tools/relay");

useWebSocketImplementation(require("ws"));

const currency = process.argv[2] || 'USD';

const run = async () => {
  const encryptedContent = await encrypt(
    NWC_CONNECTION_SECRET,
    NWC_SERVICE_PUBKEY,
    JSON.stringify({
      method: "get_exchange_rates",
      params: { currency },
    }),
  );
  const eventTemplate = {
    kind: NWCWalletRequest,
    created_at: Math.round(Date.now() / 1000),
    content: encryptedContent,
    tags: [["p", NWC_SERVICE_PUBKEY]],
  };
  const signedEvent = finalizeEvent(eventTemplate, NWC_CONNECTION_SECRET);

  try {
    console.log("broadcasting...", signedEvent);
    const relay = await Relay.connect(RELAY_URI);

    await relay.publish(signedEvent);
    console.log("successfully published example get_exchange_rates request");
    relay.close();
  } catch (err) {
    console.error("failed to publish NWC request", err);
  }
};

run();
