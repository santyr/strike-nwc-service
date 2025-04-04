const axios = require("axios");
const Big = require("big.js");
const { STRIKE_API_KEY, STRIKE_SOURCE_CURRENCY } = require("./constants");

const createStrikePaymentQuote = async (invoice) => {
  const { data } = await axios({
    method: "post",
    url: "https://api.strike.me/v1/payment-quotes/lightning",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${STRIKE_API_KEY}`,
    },
    data: JSON.stringify({
      lnInvoice: invoice,
      sourceCurrency: STRIKE_SOURCE_CURRENCY,
    }),
  });

  return data.paymentQuoteId;
};

const executeStrikePaymentQuote = async (paymentQuoteId) => {
  const { data } = await axios({
    method: "patch",
    url: `https://api.strike.me/v1/payment-quotes/${paymentQuoteId}/execute`,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${STRIKE_API_KEY}`,
    },
  });

  return data;
};

const payInvoice = async (invoice) => {
  const strikePaymentQuoteId = await createStrikePaymentQuote(invoice);

  return executeStrikePaymentQuote(strikePaymentQuoteId);
};

const convertDateTimeToUnix = (dateTime) =>
  parseInt(String(Date.parse(dateTime) / 1000));

const createInvoice = async ({ amountInMillisats, description }) => {
  const btcAmount = new Big(amountInMillisats)
    .div(1000)
    .div(100_000_000)
    .toFixed(8);
  const {
    data: { invoiceId, state, created },
  } = await axios({
    method: "post",
    url: "https://api.strike.me/v1/invoices",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${STRIKE_API_KEY}`,
    },
    data: JSON.stringify({
      description,
      amount: {
        amount: btcAmount,
        currency: "BTC",
      },
    }),
  });

  return { invoiceId, state, createdAt: convertDateTimeToUnix(created) };
};

const createQuote = async (invoiceId) => {
  const {
    data: { lnInvoice, expiration },
  } = await axios({
    method: "post",
    url: `https://api.strike.me/v1/invoices/${invoiceId}/quote`,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${STRIKE_API_KEY}`,
    },
  });

  return {
    invoice: lnInvoice,
    expiresAt: convertDateTimeToUnix(expiration),
  };
};

const makeInvoice = async ({ amountInMillisats, description }) => {
  const { invoiceId, state, createdAt } = await createInvoice({
    amountInMillisats,
    description,
  });
  const { invoice, expiresAt } = await createQuote(invoiceId);

  return { invoiceId, invoice, state, createdAt, expiresAt };
};

const lookupInvoice = async (invoiceId) => {
  const {
    data: { state },
  } = await axios({
    method: "get",
    url: `https://api.strike.me/v1/invoices/${invoiceId}`,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${STRIKE_API_KEY}`,
    },
  });

  return state;
};

const getExchangeRates = async (currency = STRIKE_SOURCE_CURRENCY) => {
  const { data } = await axios({
    method: "get",
    url: `https://api.strike.me/v1/rates/ticker`,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${STRIKE_API_KEY}`,
    },
    params: {
      currency,
    },
  });

  return data;
};

const getAccountDetails = async () => {
  const { data } = await axios({
    method: "get",
    url: "https://api.strike.me/v1/accounts/handle/me",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${STRIKE_API_KEY}`,
    },
  });

  return data;
};

const getBalance = async () => {
  const { data } = await axios({
    method: "get",
    url: "https://api.strike.me/v1/balances/me",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${STRIKE_API_KEY}`,
    },
  });

  return data;
};

const getTransactions = async (limit = 10, offset = 0) => {
  const { data } = await axios({
    method: "get",
    url: "https://api.strike.me/v1/transactions",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${STRIKE_API_KEY}`,
    },
    params: {
      limit,
      offset,
    },
  });

  return data;
};

module.exports = { 
  payInvoice, 
  makeInvoice, 
  lookupInvoice,
  getExchangeRates,
  getAccountDetails,
  getBalance,
  getTransactions
};
