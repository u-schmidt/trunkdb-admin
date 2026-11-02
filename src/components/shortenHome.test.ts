import { describe, expect, it } from "vitest";
import { shortenHome } from "./shortenHome";

describe("shortenHome", () => {
  it("replaces a macOS home folder with ~", () => {
    expect(shortenHome("/Users/alice/Documents/shop.trunkdb")).toBe("~/Documents/shop.trunkdb");
  });

  it("replaces a Linux home folder with ~", () => {
    expect(shortenHome("/home/alice/shop.trunkdb")).toBe("~/shop.trunkdb");
  });

  it("replaces every home path inside a sentence", () => {
    expect(shortenHome("Moved /Users/alice/a.jsonl to /Users/alice/b.jsonl")).toBe(
      "Moved ~/a.jsonl to ~/b.jsonl",
    );
  });

  it("leaves other paths alone", () => {
    expect(shortenHome("/Volumes/Data/shop.trunkdb")).toBe("/Volumes/Data/shop.trunkdb");
  });
});
