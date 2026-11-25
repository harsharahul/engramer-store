import { describe, expect, it } from "vitest";
import { withoutZones, zonesOf } from "./zones";

const lines = (...text: string[]) => text.join("\n");
const words = (text: string, span?: { at: number; end: number }) => (span ? text.slice(span.at, span.end) : undefined);

describe("zonesOf: the parts of a message that are not its own words", () => {
  it("lines that start with > are quoted", () => {
    const text = lines("Fine by me.", "", "> Can we arrive on 11 March 2027?", "> Total | £240.00", "", "See you then.");
    const zones = zonesOf(text);
    expect(zones.quoted.map((span) => words(text, span))).toEqual(["> Can we arrive on 11 March 2027?\n> Total | £240.00"]);
    expect(zones.forwarded).toBeUndefined();
    expect(zones.footer).toBeUndefined();
  });

  it("what follows the line that names who wrote it is quoted, to the end", () => {
    const text = lines("Dinner is on Friday 4 June 2027 at 19:00.", "", "On 24 May 2027 Sam wrote:", "", "Check-in is Fri 11 June 2027.", "Thanks");
    expect(zonesOf(text).quoted.map((span) => words(text, span))).toEqual(["On 24 May 2027 Sam wrote:\n\nCheck-in is Fri 11 June 2027.\nThanks"]);
  });

  it("a forwarded message is forwarded, not quoted; what it quotes in turn is quoted", () => {
    const forward = lines("---------- Forwarded message ---------", "From: Harbour Guest House Example <stay@example.com>", "Date: Mon, 1 Mar 2027", "Subject: Booking confirmed", "", "Check-in | Fri 12 March 2027");
    const text = lines("Our booking, for your diary.", "", forward);
    expect(zonesOf(text)).toEqual({ quoted: [], forwarded: { at: text.indexOf("----------"), end: text.length } });
    const replied = lines(text, "", "On 20 February 2027 Alex wrote:", "> Do you have a room from 11 March 2027?");
    const zones = zonesOf(replied);
    expect(words(replied, zones.forwarded)).toBe(`${forward}\n\n`);
    expect(zones.quoted.map((span) => words(replied, span))).toEqual(["On 20 February 2027 Alex wrote:\n> Do you have a room from 11 March 2027?"]);
  });

  it("a footer starts at the line of its first mark in the last part of the message, and runs to its end", () => {
    const footer = "Pay by direct debit before 30 April 2027 and get a £10.00 credit. Unsubscribe. Terms and conditions.";
    const text = lines("Your bill is ready.", "", "Payment due | 19 April 2027", "Amount due | £126.40", "", "Thank you for being a customer of Northline Energy Example. We are glad to have you with us.", "", footer);
    expect(words(text, zonesOf(text).footer)).toBe(footer);
  });

  it("a mark near the top is no footer: the body under it is read", () => {
    const text = lines("View this email in your browser | Unsubscribe", "", "Your booking is confirmed.", "Check-in | Fri 12 March 2027", "Check-out | Mon 15 March 2027", "Total | £429.00", "We look forward to welcoming you to the Harbour Guest House Example.");
    expect(zonesOf(text).footer).toBeUndefined();
    expect(zonesOf(lines("Hello,", "Unsubscribe me from the swimming list please.", "I can still come on 12 March 2027.", "Thanks", "Alex")).footer).toBeUndefined();
  });

  it("one mark alone starts a footer only in the last two fifths of a message", () => {
    // One long line: its mark stands far along it, the line starts at the top.
    const text = `${"Your booking is confirmed for 12 March 2027. ".repeat(6)}All rights reserved.`;
    const { footer } = zonesOf(text);
    expect(words(text, footer)).toBe("All rights reserved.");
    expect(footer!.at).toBeGreaterThanOrEqual(Math.floor(text.length * 0.6));
    // A person who writes the word in the middle of a short note has written no footer.
    expect(zonesOf(lines("Hello Sam, thanks for the reminder about the meeting.", "Please unsubscribe me from the list. I will come on 12 March 2027.", "Alex")).footer).toBeUndefined();
  });

  it("a long footer under a short message starts at its first line: two marks of a footer say so", () => {
    const footer = "You received this email because you booked online. Book again before 30 April 2027 and save 15%. Unsubscribe";
    const text = lines("Thanks for booking with us.", "", "Your table is held on 12 March 2027 at 19:30 for four people, in the garden room.", "", footer);
    expect(words(text, zonesOf(text).footer)).toBe(footer);
    // The same two marks in the first lines of a message are no footer.
    const top = lines("You received this email because you booked online. Unsubscribe", "", "Your table is held on 12 March 2027 at 19:30.", "See you then.", "The Garden Room Example team, at your service all week.");
    expect(zonesOf(top).footer).toBeUndefined();
  });

  it("words that a body uses too start the footer where they stand: the sentence before them is the body's", () => {
    const text = lines("Your stay is booked.", "", "Check-in | Fri 12 March 2027", "Check-out | Mon 15 March 2027", "", "We look forward to welcoming you.", "Free cancellation until 10 March 2027. Terms and conditions apply.");
    expect(words(text, zonesOf(text).footer)).toBe("Terms and conditions apply.");
  });

  it("the footer is looked for in the message's own words, before what it quotes", () => {
    const own = lines("Thanks for the details, that all works for us and we will see you on 12 March 2027 at the house.", "", "Unsubscribe from this list");
    const text = lines(own, "", "On 1 March 2027 Sam wrote:", "", `> ${"We have a room for you. ".repeat(40)}`);
    expect(words(text, zonesOf(text).footer)).toBe("Unsubscribe from this list\n\n");
  });

  it("a text with none of these has no zones", () => {
    expect(zonesOf("Check-in | Fri 12 March 2027\nTotal | £429.00")).toEqual({ quoted: [] });
    expect(zonesOf("")).toEqual({ quoted: [] });
  });
});

describe("withoutZones", () => {
  it("blanks the spans with spaces and keeps every line where it was", () => {
    expect(withoutZones("ab\ncd\nef", [{ at: 1, end: 7 }])).toBe("a \n  \n f");
    expect(withoutZones("ab\ncd\nef", [{ at: 6, end: 8 }, { at: 0, end: 1 }, { at: 0, end: 2 }])).toBe("  \ncd\n  ");
    expect(withoutZones("ab\ncd\nef", [])).toBe("ab\ncd\nef");
  });
});
