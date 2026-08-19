import { audienceMatches, type AudienceType } from "./audience.ts";

function assertMatches(
  audienceType: AudienceType,
  registeredForSelected: boolean,
  everRegistered: boolean,
  expected: boolean,
) {
  const actual = audienceMatches(audienceType, {
    registeredForSelected,
    everRegistered,
  });
  if (actual !== expected) {
    throw new Error(
      `${audienceType}: expected ${expected}, received ${actual}`,
    );
  }
}

Deno.test("not registered audience includes new and previous contacts", () => {
  assertMatches("not_registered_for_event", false, false, true);
  assertMatches("not_registered_for_event", false, true, true);
  assertMatches("not_registered_for_event", true, true, false);
});

Deno.test("previously registered audience stays limited to past attendees", () => {
  assertMatches("previously_registered_not_registered", false, true, true);
  assertMatches("previously_registered_not_registered", false, false, false);
  assertMatches("previously_registered_not_registered", true, true, false);
});
