/**
 * Synthetic mailbox for the mail scale spike. Deterministic for a seed, so
 * every mode and engine measures the same messages. Every name, address and
 * number here is invented; nothing resembles a real mailbox.
 */

export const WORDS = (
  "about above account across action active actual added address advance after again agenda " +
  "agree ahead allow almost along already also always amount annual answer apply april arrive " +
  "article asked attach august autumn available average back balance basic before begin below " +
  "better between billing board book bottom branch brief bring budget build business call " +
  "calendar cancel capital card care carry case center change charge check choice city claim " +
  "class clear client close coffee collect color common company complete confirm contact " +
  "contract copy corner cost could count country course cover create credit current customer " +
  "daily date dear december deliver delivery detail direct discount document done draft during " +
  "early easy edit effect either email enjoy enough entry equal estimate evening event every " +
  "exact example extra family february fee field figure file final find first follow form " +
  "forward free friday friend front full garden general gift given glad good group guest guide " +
  "happy have heard help hello holiday home hope hotel hour house idea include income inside " +
  "invoice item january join journey july june just keep kind kitchen later learn least leave " +
  "letter level light limit line link list little local look lunch main make manage march market " +
  "matter maybe meet member message method middle minute monday month morning move music " +
  "nearly need never news next night note notice november number october offer office often " +
  "open order other owner package page paid paper part party pass payment people period phone " +
  "photo place plan please point policy price print private program project provide question " +
  "quick quiet rate ready reason receipt receive record refund regard remind renew reply report " +
  "request reserve return review right room route saturday save schedule school season second " +
  "secure send september service share ship short simple small soon special staff start " +
  "statement station status still store street subject summer sunday supply support sure table " +
  "team thank thanks thursday ticket time today together total track travel trip tuesday update " +
  "usual valid value visit wait walk week weekend welcome wednesday window winter wish within " +
  "work world write year yesterday"
).split(/\s+/);

const NEEDLE = "zephyrine";

const NAMES = [
  "Jordan Vale", "Priya Anand", "Mateo Ruiz", "Lena Hartmann", "Sam Okafor", "Noor Haddad",
  "Elio Brandt", "Mina Sato", "Ravi Kumar", "Ines Moreau", "Tomas Novak", "Ada Lindqvist",
];

const KINDS = [
  {
    kind: "booking",
    weight: 1,
    subject: (r) => `Your booking is confirmed, reference QX${pad(r(9999), 4)}`,
    opener: "Thank you for your reservation. Here are the details of your stay and journey.",
  },
  {
    kind: "bill",
    weight: 2,
    subject: (r) => `Your statement for account ending ${pad(r(9999), 4)} is ready`,
    opener: "Your latest statement is available. The amount due and the due date are below.",
  },
  {
    kind: "receipt",
    weight: 2,
    subject: (r) => `Receipt for order ${pad(r(999999), 6)}`,
    opener: "Thanks for your order. This email is your receipt for the items listed below.",
  },
  {
    kind: "newsletter",
    weight: 4,
    subject: (r) => `Weekly notes, issue ${1 + r(400)}`,
    opener: "Here is this week's round of news, updates and a few things worth reading.",
  },
  {
    kind: "personal",
    weight: 3,
    subject: (r) => `Re: plans for ${WORDS[r(WORDS.length)]} on the weekend`,
    opener: "Hi, quick note about the plan we talked about. Let me know what works for you.",
  },
];

const TOTAL_WEIGHT = KINDS.reduce((sum, k) => sum + k.weight, 0);
const END = Date.UTC(2026, 9, 1);
const SPAN = 730 * 86_400_000;

function pad(n, width) {
  return String(n).padStart(width, "0");
}

function xorshift32(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4_294_967_296;
  };
}

/**
 * `count` messages, newest first, spread over the 24 months before
 * 2026-10-01. Exactly the messages at indices 7, 4,321 and count minus 5
 * (those that exist) carry the needle word, close to the start of the text
 * so no length cut can remove it.
 */
export function makeCorpus(count, seed) {
  const next = xorshift32(seed);
  const int = (n) => Math.floor(next() * n);
  const needles = new Set([7, 4_321, count - 5].filter((i) => i >= 0 && i < count));
  const messages = [];
  for (let i = 0; i < count; i++) {
    let pick = next() * TOTAL_WEIGHT;
    const template = KINDS.find((k) => (pick -= k.weight) < 0) ?? KINDS[KINDS.length - 1];
    const name = NAMES[int(NAMES.length)];
    const domain = next() < 0.5 ? "example.com" : "example.net";
    const from = `${name} <${name.toLowerCase().replace(/\s+/g, ".")}@${domain}>`;
    const date = END - Math.floor(((i + next()) * SPAN) / count);
    const target = 400 + Math.floor(5_600 * Math.pow(next(), 1.7));
    let text = template.opener;
    if (needles.has(i)) {
      text += ` The ${NEEDLE} file is attached.`;
    }
    while (text.length < target) {
      text += " " + WORDS[int(WORDS.length)];
    }
    text = text.slice(0, target);
    const subject = template.subject(int);
    const id = `spike-${seed}-${i}`;
    const raw =
      `From: ${from}\r\n` +
      `To: Alex Morgan <alex.morgan@example.com>\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${new Date(date).toUTCString()}\r\n` +
      `Message-ID: <${id}@example.com>\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `\r\n` +
      text;
    messages.push({ id, subject, from, date, text, raw });
  }
  return messages;
}
