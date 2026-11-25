import { describe, expect, it } from "vitest";
import { htmlToText, mailBodyText } from "./htmltext";

const lines = (...text: string[]) => text.join("\n");

describe("htmlToText: an HTML mail as its lines, rows and cells", () => {
  it("a row of cells is one line, its cells parted by a bar", () => {
    expect(
      htmlToText("<table><tr><th>Check-in</th><th>Check-out</th></tr><tr><td>Fri 12 March 2027</td><td>Mon 15 March 2027</td></tr></table>"),
    ).toBe(lines("Check-in | Check-out", "Fri 12 March 2027 | Mon 15 March 2027"));
  });

  it("an empty cell keeps its place in the row, and a cell that spans columns takes their places", () => {
    expect(htmlToText("<table><tr><td><b>Total</b></td><td></td><td> </td><td><b>&pound;429.00</b></td></tr></table>")).toBe("Total | | | £429.00");
    expect(htmlToText(`<table><tr><td colspan="3">Total</td><td>&pound;429.00</td></tr></table>`)).toBe("Total | | | £429.00");
    expect(htmlToText("<table><tr><th></th><th>Date</th><th>Amount</th></tr><tr><td>Gas</td><td>1 Oct</td><td>34.25</td></tr></table>")).toBe(
      lines("| Date | Amount", "Gas | 1 Oct | 34.25"),
    );
  });

  it("a row needs two cells with words: gutters and spacers add no bar", () => {
    expect(htmlToText(`<table><tr><td width="20"></td><td><p>Hello there.</p></td><td width="20">&nbsp;</td></tr></table>`)).toBe("Hello there.");
    expect(htmlToText(`<table><tr><td></td><td>&nbsp;</td></tr><tr><td colspan="2">Your stay</td></tr></table>`)).toBe("Your stay");
  });

  it("a cell that holds blocks is layout: it parts lines and adds no bar, and a table inside it still has its rows", () => {
    const html = `<table width="600"><tr><td>
      <h1>Harbour Guest House Example</h1>
      <p>Thank you for your booking.</p>
      <table><tr><td>Check-in</td><td>Fri 12 March 2027</td></tr><tr><td>Check-out</td><td>Mon 15 March 2027</td></tr></table>
      <p>See you soon.</p>
    </td></tr><tr><td><p>Small print.</p></td></tr></table>`;
    expect(htmlToText(html)).toBe(
      lines(
        "Harbour Guest House Example",
        "",
        "Thank you for your booking.",
        "",
        "Check-in | Fri 12 March 2027",
        "Check-out | Mon 15 March 2027",
        "",
        "See you soon.",
        "",
        "Small print.",
      ),
    );
  });

  it("a cell is one cell when it holds one line, whatever wraps it; two blocks in a cell make the row layout", () => {
    expect(htmlToText("<table><tr><td><p>Total</p></td><td><div><b>&pound;429.00</b></div></td></tr></table>")).toBe("Total | £429.00");
    expect(htmlToText("<table><tr><td><p>Left words.</p><p>More on the left.</p></td><td><p>Right words.</p></td></tr></table>")).toBe(
      lines("Left words.", "", "More on the left.", "", "Right words."),
    );
  });

  it("a break inside a cell: a label keeps a value set on two lines; lines side by side stay lines", () => {
    expect(htmlToText("<table><tr><td>Check-in</td><td>Fri 12 March 2027<br>from 15:00</td></tr></table>")).toBe("Check-in | Fri 12 March 2027 from 15:00");
    // One big cell whose lines are parted by breaks: the oldest mail layout there is.
    expect(htmlToText("<table><tr><td>Dear Alex,<br><br>Your booking is confirmed.<br>Check-in: 12 March 2027<br>Check-out: 15 March 2027</td></tr></table>")).toBe(
      lines("Dear Alex,", "", "Your booking is confirmed.", "Check-in: 12 March 2027", "Check-out: 15 March 2027"),
    );
    // Two columns of lines: an address beside the invoice's fields.
    expect(
      htmlToText("<table><tr><td>Lakeside Plumbing Example<br>12 High Street</td><td>Invoice date: 5 November 2026<br>Payment due: 23 November 2026</td></tr></table>"),
    ).toBe(lines("Lakeside Plumbing Example", "12 High Street", "", "Invoice date: 5 November 2026", "Payment due: 23 November 2026"));
  });

  it("rows of one cell each are lines one under the other", () => {
    expect(htmlToText("<table><tr><td>Check-in</td></tr><tr><td>Friday 12 March 2027</td></tr><tr><td>Check-out</td></tr><tr><td>Monday 15 March 2027</td></tr></table>")).toBe(
      lines("Check-in", "Friday 12 March 2027", "Check-out", "Monday 15 March 2027"),
    );
  });

  it("decodes the signs of money and the common named and numbered entities, and leaves an unknown one as written", () => {
    expect(htmlToText("<p>&pound;429.00 &euro;88,50 &#8364;1 &#x20AC;2 &yen;300 &cent;5 &amp; &lt;b&gt; &quot;x&quot; &apos;y&apos; a&nbsp;b &copy; 2027 &ndash; &mdash; &hellip; &rsquo; &bogus;</p>")).toBe(
      `£429.00 €88,50 €1 €2 ¥300 ¢5 & <b> "x" 'y' a b © 2027 ${[0x2013, 0x2014, 0x2026, 0x2019].map((code) => String.fromCodePoint(code)).join(" ")} &bogus;`,
    );
    // As a browser reads them: the old entities with no semicolon, and the old Windows numbers.
    expect(htmlToText("<p>&pound429.00 &#163;5 &#128;7 &copy 2027 &minus;3</p>")).toBe(`£429.00 £5 €7 © 2027 ${String.fromCodePoint(0x2212)}3`);
    // An ampersand in running words is an ampersand.
    expect(htmlToText("<p>AT&T, fish&chips, Q&A; R&D</p>")).toBe("AT&T, fish&chips, Q&A; R&D");
  });

  it("drops what the page hides from the eye", () => {
    const hidden = [
      `<span style="display:none">A</span>`,
      `<span style="display: none !important; max-height:0">B</span>`,
      `<div style="visibility:hidden">C</div>`,
      `<div hidden>D</div>`,
      `<div style="font-size:0">E</div>`,
      `<div style="font-size: 0px; line-height:0">F</div>`,
      `<div style="opacity:0">G</div>`,
      `<div style="max-height:0;overflow:hidden">H</div>`,
      `<div STYLE='color:#fff;DISPLAY:NONE'>I</div>`,
    ];
    expect(htmlToText(`${hidden.join("")}<p>Seen.</p>`)).toBe("Seen.");
    // Hidden with what it holds, however deep; what comes after it is seen again.
    expect(htmlToText(`<div style="display:none"><p>one <span>two</span></p><div>three</div></div><p>Seen.</p>`)).toBe("Seen.");
    // A size or an opacity that is small, not nothing, is seen.
    expect(htmlToText(`<p style="font-size:0.9em;opacity:0.8;max-height:200px">Seen.</p>`)).toBe("Seen.");
    // Padding of characters with no width is nothing.
    expect(htmlToText("<div>&#8204;&nbsp;&#847;&zwnj;&#8203;&shy;</div><p>Seen.</p>")).toBe("Seen.");
  });

  it("shows what a browser shows: text sized again inside a wrapper of size nothing, and text hidden from one mail program only", () => {
    // Layout builders set size nothing on every wrapper and a real size on the text inside.
    expect(htmlToText(`<table><tr><td style="font-size:0px;padding:10px 25px"><div style="font-size:13px;line-height:1">Hello World</div></td></tr></table>`)).toBe("Hello World");
    expect(htmlToText(`<div style="font-size:0">a<span style="font-size:12px">b</span>c</div><p>Seen.</p>`)).toBe(lines("b", "", "Seen."));
    expect(htmlToText(`<a style="mso-hide:all" href="https://example.com/b">View booking</a>`)).toBe("View booking");
  });

  it("a hidden row or cell is no part of its table, and a hidden piece left open hides no more than its own cell", () => {
    expect(htmlToText(`<table><tr style="display:none"><td>Phone</td><td>only</td></tr><tr><td>Check-in</td><td>Fri 12 March 2027</td></tr></table>`)).toBe(
      "Check-in | Fri 12 March 2027",
    );
    expect(htmlToText(`<table><tr><td style="display:none">x</td><td>Check-in</td><td>Fri 12 March 2027</td></tr></table>`)).toBe("Check-in | Fri 12 March 2027");
    expect(htmlToText(`<table><tr><td><span style="display:none">Preheader <b>words</td></tr><tr><td>Seen.</td></tr></table><p>After.</p>`)).toBe(
      lines("Seen.", "", "After."),
    );
    expect(htmlToText(`<table><tr><td><div style="font-size:0">gone</td><td>Seen</td><td>too</td></tr></table>`)).toBe("| Seen | too");
  });

  it("a hidden piece left open ends where a browser ends it, and the words after it are read", () => {
    // The closing tag of what stands around it ends it.
    expect(htmlToText(`<div><span style="display:none">Preview words</div><p>Your total is £20.00, due 3 March 2027.</p><p>Thanks</p>`)).toBe(
      lines("Your total is £20.00, due 3 March 2027.", "", "Thanks"),
    );
    expect(htmlToText(`<p><span style="display:none">Preview words</p><p>Your total is £20.00.</p>`)).toBe("Your total is £20.00.");
    // A hidden paragraph ends where the next block starts, a hidden list item where the next item starts.
    expect(htmlToText(`<p style="display:none">Preview words<p>Dear Alex, your total is £20.00.</p><p>Thanks</p>`)).toBe(lines("Dear Alex, your total is £20.00.", "", "Thanks"));
    expect(htmlToText(`<ul><li style="display:none">x<li>Visible one<li>Visible two</ul><p>After</p>`)).toBe(lines("- Visible one", "- Visible two", "", "After"));
    // The same for a paragraph of size nothing.
    expect(htmlToText(`<p style="font-size:0;line-height:0">&nbsp;<div>Your total is £20.00.</div>`)).toBe("Your total is £20.00.");
    expect(htmlToText(`<div><span style="font-size:0">Preview <b>words</div><p>Seen.</p>`)).toBe("Seen.");
    // What is hidden and closed stays hidden with all it holds.
    expect(htmlToText(`<div style="display:none"><p>one</p><ul><li>two<li>three</ul><p>four</div><p>Seen.</p>`)).toBe("Seen.");
    expect(
      mailBodyText({
        text: "Order 1234\nIt will arrive on 3 March 2027.",
        html: `<table><tr><td>Order</td><td>1234</td></tr></table><div><span style="display:none">Preview</div><p>It will arrive on 3 March 2027.</p>`,
      }),
    ).toBe(lines("Order | 1234", "", "It will arrive on 3 March 2027."));
  });

  it("shows what only a careless rule would hide", () => {
    // A comment closed the other way a browser accepts.
    expect(htmlToText("<p>Before</p><!-- note --!><p>After</p>")).toBe(lines("Before", "", "After"));
    // Inside a wrapper of size nothing, text that a class or a font element may size.
    expect(htmlToText(`<table><tr><td style="font-size:0"><div class="column"><p class="words">Hello</p></div></td></tr></table>`)).toBe("Hello");
    expect(htmlToText(`<div style="font-size:0"><font size="2">Hello</font></div>`)).toBe("Hello");
    // A height of nothing hides only what cannot overflow it.
    expect(htmlToText(`<div style="max-height:0">Overflowing words</div>`)).toBe("Overflowing words");
  });

  it("text set as it is written keeps its lines and its gaps", () => {
    expect(htmlToText("<pre>Booking reference: ABC123\nCheck-in: 12 March 2027\nCheck-out: 15 March 2027</pre>")).toBe(
      lines("Booking reference: ABC123", "Check-in: 12 March 2027", "Check-out: 15 March 2027"),
    );
    expect(htmlToText(`<div style="white-space: pre-wrap">Dear Alex,\n\nYour total is £20.00.\nThanks</div><p>After   words.</p>`)).toBe(
      lines("Dear Alex,", "", "Your total is £20.00.", "Thanks", "", "After words."),
    );
    expect(htmlToText("<pre>Date         Amount\n3 May 2027   £40.00\n</pre>")).toBe(lines("Date         Amount", "3 May 2027   £40.00"));
  });

  it("a table inside a cell is no part of the row around it", () => {
    expect(htmlToText("<table><tr><td>Your order</td><td><table><tr><td>Total</td><td>&pound;429.00</td></tr></table></td></tr></table>")).toBe(
      lines("Your order", "", "Total | £429.00"),
    );
  });

  it("head, style, script and comments give nothing, and a head left open does not take the body with it", () => {
    expect(htmlToText("<html><head><title>T</title><style>p{color:red}</style></head><body><script>var a = '<p>no</p>';</script><!-- <p>no</p> --><p>Yes.</p></body></html>")).toBe("Yes.");
    expect(htmlToText("<html><head><title>T</title><style>a{}</style><body><p>Yes.</p></body></html>")).toBe("Yes.");
    // What is written for one mail program only, inside a comment, is not shown; its twin for the others is.
    expect(htmlToText("<!--[if mso]><p>For one program.</p><![endif]--><!--[if !mso]><!--><p>For the others.</p><!--<![endif]-->")).toBe("For the others.");
  });

  it("a quoted message is marked line by line, a quote within a quote twice", () => {
    expect(htmlToText("<p>Fine by me.</p><blockquote><p>Can we arrive on 11 March 2027?</p><blockquote>Earlier words.</blockquote><table><tr><td>Total</td><td>&pound;240.00</td></tr></table></blockquote><p>After.</p>")).toBe(
      lines("Fine by me.", "", "> Can we arrive on 11 March 2027?", "", "> > Earlier words.", "", "> Total | £240.00", "", "After."),
    );
  });

  it("list items start with a dash, a break ends a line, a link keeps its words", () => {
    expect(htmlToText(`<ul><li>One</li><li>Two <a href="https://example.com/x?a=1&amp;b=2">here</a></li></ul>First<br>Second<br/>Third`)).toBe(
      lines("- One", "- Two here", "", "First", "Second", "Third"),
    );
  });

  it("joins the words of one line however the source is wrapped and spaced", () => {
    expect(htmlToText("<p>Your   appointment\n   is on\t<b>Tuesday</b>,\n8 December 2026.</p>")).toBe("Your appointment is on Tuesday, 8 December 2026.");
    expect(htmlToText("<table>\n <tr>\n  <td> Check-in </td>\n  <td>\n   Fri 12 March 2027\n  </td>\n </tr>\n</table>")).toBe("Check-in | Fri 12 March 2027");
  });

  it("survives markup that is not well formed", () => {
    // A cell and a row left open, a bar in an attribute, a tag never closed.
    expect(htmlToText(`<table><tr><td>A<td>B<tr><td title="x > y">C</td><td>D</td></table><p>End`)).toBe(lines("A | B", "C | D", "", "End"));
    expect(htmlToText("Plain words, no tags.")).toBe("Plain words, no tags.");
    expect(htmlToText("<p>Less < than, and an open <tag")).toBe("Less < than, and an open");
    expect(htmlToText("<p>a </ b, 2 <3 and c</p>")).toBe("a </ b, 2 <3 and c");
    expect(htmlToText("")).toBe("");
    // A quote mark is a quote only after an equals sign; one never closed ends with its tag.
    expect(htmlToText("<p>Before <img alt=Bob's photo> after. It's fine.</p>")).toBe("Before after. It's fine.");
    expect(htmlToText(`<p>One</p><a href="x>Two</a><p>Three</p>`)).toBe(lines("One", "", "Two", "", "Three"));
    // A table left open inside a cell, then the outer row closes.
    expect(htmlToText("<table><tr><td>Out<table><tr><td>A</td><td>B</td></tr></td></tr></table><p>End</p>")).toContain("A | B");
  });

  it("reads a very large message in one pass", () => {
    // Twenty thousand cells, two megabytes.
    const cell = "x".repeat(80);
    const rows = Array.from({ length: 10_000 }, (_, i) => `<tr><td class="label">Item ${i} ${cell}</td><td class="amount">${i}.00 ${cell}</td></tr>`).join("");
    expect(rows.length).toBeGreaterThan(2_000_000);
    const started = performance.now();
    const text = htmlToText(`<table>${rows}</table>`);
    expect(performance.now() - started).toBeLessThan(400);
    expect(text.split("\n")).toHaveLength(10_000);
    // Tables inside tables, deeper than any mail: no failure, the words are kept.
    const deep = `${"<table><tr><td>".repeat(200)}Deep words${"</td></tr></table>".repeat(200)}`;
    expect(htmlToText(deep)).toContain("Deep words");
  });

  it("takes time in proportion to the input, whatever the input", () => {
    const timed = (html: string) => {
      const started = performance.now();
      const text = htmlToText(html);
      return { text, ms: performance.now() - started };
    };
    // Tags that never match, inside a hidden piece.
    const unmatched = timed(`<div style="display:none">${"<b>".repeat(30_000)}${"</i>".repeat(30_000)}</div><p>Seen.</p>`);
    expect(unmatched).toMatchObject({ text: "Seen." });
    expect(unmatched.ms).toBeLessThan(300);
    // Quotes never closed, style blocks by the thousand, comments never closed.
    expect(timed(`<a href='x>y`.repeat(30_000)).ms).toBeLessThan(300);
    expect(timed("<style>a{}</style><p>x</p>".repeat(30_000)).ms).toBeLessThan(300);
    expect(timed(`${"<p>x</p>".repeat(30_000)}<!-- open`).ms).toBeLessThan(300);
    expect(timed("<".repeat(200_000)).ms).toBeLessThan(300);
    expect(timed("&".repeat(200_000)).ms).toBeLessThan(300);
  });
});

describe("mailBodyText: which body of a message is read", () => {
  const table = "<p>Your booking.</p><table><tr><td>Check-in</td><td>Fri 12 March 2027</td></tr></table>";

  it("the plain part of a mail in running words", () => {
    expect(mailBodyText({ text: "Hello there, see you at 8.", html: "<p>Hello there, see you at <b>8</b>.</p>" })).toBe("Hello there, see you at 8.");
    // A bar in running words is no row of cells.
    expect(mailBodyText({ text: "Hello there.\nNews | Sport | Weather", html: "<p>Hello <b>there</b>.</p><p>News | Sport | Weather</p>" })).toBe(
      "Hello there.\nNews | Sport | Weather",
    );
  });

  it("the HTML part when it holds a row of cells", () => {
    expect(mailBodyText({ text: "Your booking. Check-in Fri 12 March 2027", html: table })).toBe(lines("Your booking.", "", "Check-in | Fri 12 March 2027"));
  });

  it("the HTML part when the plain part is a stub, or empty", () => {
    const long = "<p>Your parcel will arrive on Wednesday 21 July 2027 and someone must be home to sign for it.</p>";
    expect(mailBodyText({ text: "View this email in your browser.", html: long })).toBe(htmlToText(long));
    expect(mailBodyText({ text: "", html: "<p>Only here.</p>" })).toBe("Only here.");
    expect(mailBodyText({ text: "  \n", html: "<p>Only here.</p>" })).toBe("Only here.");
  });

  it("whichever part there is, and nothing for nothing", () => {
    expect(mailBodyText({ text: "Only plain." })).toBe("Only plain.");
    expect(mailBodyText({ html: "<p>Only HTML.</p>" })).toBe("Only HTML.");
    expect(mailBodyText({})).toBe("");
  });
});
