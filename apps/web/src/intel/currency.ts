/**
 * The currencies the readers know: by symbol and by three-letter code.
 * One list, so an amount, its label and its unit are read with the same
 * names everywhere.
 */

export const SYMBOL_CURRENCY: Record<string, string> = {
  $: "USD",
  "£": "GBP",
  "€": "EUR",
  "₹": "INR",
  "¥": "JPY",
};

export const CURRENCY_CODES: ReadonlySet<string> = new Set([
  "USD", "EUR", "GBP", "INR", "JPY", "CAD", "AUD", "CHF",
  "CNY", "SEK", "NZD", "SGD", "AED", "ZAR", "NOK", "DKK",
]);

/** The currencies a symbol can stand for: a code behind the amount says which ("$35.00 CAD"). */
export const SYMBOL_FAMILY: Record<string, readonly string[]> = {
  $: ["USD", "CAD", "AUD", "NZD", "SGD"],
  "£": ["GBP"],
  "€": ["EUR"],
  "₹": ["INR"],
  "¥": ["JPY", "CNY"],
};
