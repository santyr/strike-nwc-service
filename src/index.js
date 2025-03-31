const lightBolt11Decoder = require("light-bolt11-decoder");
const { finalizeEvent } = require("nostr-tools/pure");
const { useWebSocketImplementation, Relay } = require("nostr-tools/relay");
const { NWCWalletRequest, NWCWalletResponse } = require("nostr-tools/kinds");
const { encrypt, decrypt } = require("nostr-tools/nip04");
const {
  RELAY_URI,
  TOTAL_MAX_SEND_AMOUNT_IN_SATS,
  NWC_CONNECTION_PUBKEY,
  NWC_CONNECTION_SECRET,
  NWC_SERVICE_PUBKEY,
  AUTHORIZED_PUBKEY,
  LOG_LEVEL,
} = require("./constants");
const { 
  payInvoice, 
  makeInvoice, 
  lookupInvoice,
  getExchangeRates,
  getAccountDetails,
  getBalance,
  getTransactions
} = require("./strike");

useWebSocketImplementation(require("ws"));

let totalAmountSentInSats = 0;
const cachedInvoiceResults = {};

// Error codes
const UNAUTHORIZED = "UNAUTHORIZED";
const NOT_IMPLEMENTED = "NOT_IMPLEMENTED";
const QUOTA_EXCEEDED = "QUOTA_EXCEEDED";
const PAYMENT_FAILED = "PAYMENT_FAILED";
const INTERNAL = "INTERNAL";
const NOT_FOUND = "NOT_FOUND";
const INVALID_PARAMS = "INVALID_PARAMS";

// Logging function with level control
const logger = {
  debug: (...args) => {
    if (LOG_LEVEL === 'DEBUG') console.log('[DEBUG]', ...args);
  },
  info: (...args) => {
    if (LOG_LEVEL === 'DEBUG' || LOG_LEVEL === 'INFO' || !LOG_LEVEL) console.log('[INFO]', ...args);
  },
  error: (...args) => {
    console.error('[ERROR]', ...args);
  }
};

const start = async () => {
  const relay = await Relay.connect(RELAY_URI);
  logger.info(`Connected to ${RELAY_URI}`);

  relay.onclose = () => {
    logger.info("Relay connection closed.");
  };

  relay.subscribe(
    [
      {
        authors: [NWC_CONNECTION_PUBKEY],
        kinds: [NWCWalletRequest],
      },
    ],
    {
      onevent(event) {
        logger.info("NWC request:", event);
        handleNwcRequest(relay, event);
      },
    },
    {
      onclose(reason) {
        logger.info("Relay subscription closed: ", reason);
      },
    },
  );
};

const decryptNwcRequestContent = async (eventContent) => {
  try {
    return JSON.parse(
      await decrypt(NWC_CONNECTION_SECRET, NWC_SERVICE_PUBKEY, eventContent),
    );
  } catch (err) {
    logger.error(`Error decrypting NWC request: ${err}`);
    throw new Error(UNAUTHORIZED);
  }
};

const getErrorMessage = ({ requestMethod, errorCode }) => {
  switch (errorCode) {
    case UNAUTHORIZED:
      return "Unable to decrypt NWC request content or unauthorized sender.";
    case NOT_IMPLEMENTED:
      return `${requestMethod} not currently supported.`;
    case QUOTA_EXCEEDED:
      return `Payment would exceed max quota of ${TOTAL_MAX_SEND_AMOUNT_IN_SATS}.`;
    case PAYMENT_FAILED:
      return "Unable to complete payment.";
    case NOT_FOUND:
      return "Unable to find invoice.";
    case INVALID_PARAMS:
      return "Invalid parameters provided for the request.";
    default:
      return "Something unexpected happened.";
  }
};

const makeNwcResponseEvent = async ({
  eventId,
  requestMethod,
  result,
  errorCode,
}) => {
  const content = { result_type: requestMethod };

  if (errorCode) {
    content.error = {
      code: errorCode,
      message: getErrorMessage({ requestMethod, errorCode }),
    };
  } else {
    content.result = result;
  }
  const encryptedContent = await encrypt(
    NWC_CONNECTION_SECRET,
    NWC_SERVICE_PUBKEY,
    JSON.stringify(content),
  );
  const eventTemplate = {
    kind: NWCWalletResponse,
    created_at: Math.round(Date.now() / 1000),
    content: encryptedContent,
    tags: [
      ["p", AUTHORIZED_PUBKEY],
      ["e", eventId],
    ],
  };

  logger.debug(content);

  return finalizeEvent(eventTemplate, NWC_CONNECTION_SECRET);
};

const extractAmountInSats = (invoice) => {
  return (
    lightBolt11Decoder
      .decode(invoice)
      .sections.find(({ name }) => name === "amount").value / 1000
  );
};

const handlePayInvoiceRequest = async (nwcRequestContent) => {
  const invoice = nwcRequestContent.params?.invoice;
  const amountInSats = invoice ? extractAmountInSats(invoice) : 0;

  if (totalAmountSentInSats + amountInSats > TOTAL_MAX_SEND_AMOUNT_IN_SATS) {
    throw new Error("QUOTA_EXCEEDED");
  }

  try {
    await payInvoice(invoice);
    totalAmountSentInSats = totalAmountSentInSats + amountInSats;
    logger.info(`Successfully paid ${amountInSats} sats`);
    logger.info(
      `Total amount of sats sent since this wallet service has been running: ${totalAmountSentInSats}\n\n`,
    );

    return { preimage: "gfy" };
  } catch (err) {
    logger.error(`Error making payment: ${err}`);
    throw new Error(PAYMENT_FAILED);
  }
};

const handleMakeInvoiceRequest = async (nwcRequestContent) => {
  const { amount, description } = nwcRequestContent.params;

  try {
    const { invoiceId, invoice, state, createdAt, expiresAt } =
      await makeInvoice({
        amountInMillisats: amount,
        description,
      });
    const result = {
      type: "incoming",
      invoice,
      description,
      amount,
      created_at: createdAt,
      expires_at: expiresAt,
      metadata: { state, invoice_id: invoiceId },
    };

    // cache result for lookup_invoice requests
    cachedInvoiceResults[invoice] = result;

    return result;
  } catch (err) {
    logger.error(`Error making invoice: ${err}`);
    throw new Error(INTERNAL);
  }
};

const handleLookupInvoiceRequest = async (nwcRequestContent) => {
  const { invoice } = nwcRequestContent.params;
  const cachedInvoiceResult = cachedInvoiceResults[invoice];

  if (!cachedInvoiceResult) {
    throw new Error(NOT_FOUND);
  }

  try {
    const invoiceId = cachedInvoiceResult.metadata.invoice_id;

    cachedInvoiceResult.metadata.state = await lookupInvoice(invoiceId);

    return cachedInvoiceResult;
  } catch (err) {
    logger.error(`Error looking up invoice: ${err}`);
    throw new Error(INTERNAL);
  }
};

const handleGetExchangeRatesRequest = async (nwcRequestContent) => {
  try {
    const currency = nwcRequestContent.params?.currency || STRIKE_SOURCE_CURRENCY;
    logger.debug(`Getting exchange rates for ${currency}`);
    const rates = await getExchangeRates(currency);
    return rates;
  } catch (err) {
    logger.error(`Error getting exchange rates: ${err}`);
    throw new Error(INTERNAL);
  }
};

const handleGetAccountDetailsRequest = async () => {
  try {
    logger.debug('Getting account details');
    const accountDetails = await getAccountDetails();
    return accountDetails;
  } catch (err) {
    logger.error(`Error getting account details: ${err}`);
    throw new Error(INTERNAL);
  }
};

const handleGetBalanceRequest = async () => {
  try {
    logger.debug('Getting balance');
    const balance = await getBalance();
    return balance;
  } catch (err) {
    logger.error(`Error getting balance: ${err}`);
    throw new Error(INTERNAL);
  }
};

const handleGetTransactionsRequest = async (nwcRequestContent) => {
  try {
    const limit = nwcRequestContent.params?.limit || 10;
    const offset = nwcRequestContent.params?.offset || 0;
    
    if (isNaN(limit) || isNaN(offset) || limit < 1 || limit > 100 || offset < 0) {
      throw new Error(INVALID_PARAMS);
    }
    
    logger.debug(`Getting transactions with limit ${limit} and offset ${offset}`);
    const transactions = await getTransactions(limit, offset);
    return transactions;
  } catch (err) {
    if (err.message === INVALID_PARAMS) {
      throw err;
    }
    logger.error(`Error getting transactions: ${err}`);
    throw new Error(INTERNAL);
  }
};

const handleNwcRequest = async (relay, event) => {
  let errorCode = null;
  let result = null;
  let nwcRequestContent = null;

  try {
    nwcRequestContent = await decryptNwcRequestContent(event.content);
    logger.debug('NWC request content:', nwcRequestContent);

    // Validate the request sender
    if (event.pubkey !== NWC_CONNECTION_PUBKEY) {
      logger.error(`Unauthorized request from pubkey: ${event.pubkey}`);
      throw new Error(UNAUTHORIZED);
    }

    switch (nwcRequestContent.method) {
      case "pay_invoice":
        result = await handlePayInvoiceRequest(nwcRequestContent);
        break;
      case "make_invoice":
        result = await handleMakeInvoiceRequest(nwcRequestContent);
        break;
      case "lookup_invoice":
        result = await handleLookupInvoiceRequest(nwcRequestContent);
        break;
      case "get_exchange_rates":
        result = await handleGetExchangeRatesRequest(nwcRequestContent);
        break;
      case "get_account_details":
        result = await handleGetAccountDetailsRequest();
        break;
      case "get_balance":
        result = await handleGetBalanceRequest();
        break;
      case "get_transactions":
        result = await handleGetTransactionsRequest(nwcRequestContent);
        break;
      default:
        errorCode = NOT_IMPLEMENTED;
    }
  } catch (err) {
    errorCode = err.message;
  }

  try {
    const nwcResponse = await makeNwcResponseEvent({
      eventId: event.id,
      requestMethod: nwcRequestContent?.method ?? "unknown",
      result,
      errorCode,
    });
    logger.debug("NWC response:", nwcResponse);

    relay.publish(nwcResponse);
  } catch (err) {
    logger.error("Failed to publish NWC response", err);
  }
};

start();
