import { test } from "node:test";
import assert from "node:assert/strict";
import { WORDS, makeCorpus } from "./corpus.mjs";

test("same seed gives the same corpus", () => {
  assert.deepEqual(makeCorpus(50, 7), makeCorpus(50, 7));
});

test("needle appears in exactly three messages", () => {
  const corpus = makeCorpus(20_000, 7);
  assert.equal(corpus.filter((m) => m.text.includes("zephyrine")).length, 3);
});

test("text lengths stay in range and raw carries headers", () => {
  for (const m of makeCorpus(500, 7)) {
    assert.ok(m.text.length >= 400 && m.text.length <= 6_000);
    assert.match(m.raw, /^From: .+\r\nTo: .+\r\nSubject: .+\r\nDate: .+\r\nMessage-ID: <.+>\r\n/);
  }
});

test("the word list is exported for query sampling and never holds the needle", () => {
  assert.ok(WORDS.length >= 200);
  assert.ok(!WORDS.includes("zephyrine"));
});
