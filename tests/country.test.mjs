// The country answer and its dial-code alias: which labels resolve to
// personal.country, and the "+91" forms acceptedValues() lets the same
// answer satisfy on a phone form's country-code select.
//
// The matching rules that refuse "British India" for an answer of "India"
// live in page-scripts.js and are covered by tests/verify-country.js; what
// is under test here is the popup-side wiring feeding them.

import test from "node:test";
import assert from "node:assert/strict";

import { loadLib } from "./helpers/load.mjs";
import { makeProfile, selectField, textField } from "./helpers/fixtures.mjs";

const { matchFields, acceptedValues, findDictionaryMatch, normalizeLabel } =
  loadLib("matcher.js", [
    "matchFields",
    "acceptedValues",
    "findDictionaryMatch",
    "normalizeLabel"
  ]);

const countryEntry = { path: "personal.country", sensitive: false };

const hit = (label) => {
  const found = findDictionaryMatch(normalizeLabel(label), { tagName: "select" }, []);
  return found && found.path;
};

const rowFor = (field, profile) => matchFields([field], profile, [])[0];

test("country answer", async (t) => {
  await t.test("India also accepts its calling code, +91 and 91", () => {
    assert.deepEqual([...acceptedValues(makeProfile(), countryEntry)], ["+91", "91"]);
  });

  await t.test("the shared NANP code has no bare digit, only +1", () => {
    // "1" alone could tick Canada for a United States answer whenever the
    // list sorts the wrong "+1" row first.
    const us = makeProfile({ personal: { country: "United States" } });
    assert.deepEqual([...acceptedValues(us, countryEntry)], ["+1"]);
  });

  await t.test("a country outside the dial-code table gets no aliases", () => {
    const nepal = makeProfile({ personal: { country: "Nepal" } });
    assert.deepEqual([...acceptedValues(nepal, countryEntry)], []);
  });

  await t.test("non-country paths are untouched", () => {
    assert.deepEqual([...acceptedValues(makeProfile(), { path: "personal.city" })], []);
  });

  await t.test("dial-code labels resolve to the country, not the phone number", () => {
    assert.equal(hit("Country code"), "personal.country");
    assert.equal(hit("Dial code"), "personal.country");
    assert.equal(hit("ISD code"), "personal.country");
    assert.equal(hit("Phone country code"), "personal.country");
    assert.equal(hit("Country"), "personal.country");
  });

  await t.test("a plain phone label still resolves to the phone number", () => {
    assert.equal(hit("Phone"), "personal.phone");
    assert.equal(hit("Mobile number"), "personal.phone");
  });

  await t.test("the row a dial-code select gets carries value and aliases", () => {
    const row = rowFor(selectField("Country code", ["+44 UK", "+91 India"]), makeProfile());
    assert.equal(row.matchedPath, "personal.country");
    assert.equal(row.value, "India");
    assert.deepEqual([...row.accepts], ["+91", "91"]);
  });

  await t.test("the ordinary country select is still answered with the name", () => {
    const row = rowFor(selectField("Country of residence", ["British India", "India"]), makeProfile());
    assert.equal(row.value, "India");
    assert.deepEqual([...row.accepts], ["+91", "91"]);
  });

  await t.test("a country-code text input resolves to the country too", () => {
    const row = rowFor(textField("Country code"), makeProfile());
    assert.equal(row.matchedPath, "personal.country");
    assert.equal(row.value, "India");
  });
});
