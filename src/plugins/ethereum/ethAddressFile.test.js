// @flow

import {
  parseAddress,
  truncateEthAddress as truncate,
  type EthAddress,
} from "./ethAddressFile";

describe("plugins/ethereum/ethAddressFile", () => {
  describe("parseAddress", () => {
    it("can parse a well-formed ethereum address", () => {
      [
        "2Ccc7cD913677553766873483ed9eEDdB77A0Bb0",
        "0x2Ccc7cD913677553766873483ed9eEDdB77A0Bb0",
        "0x2Ccc7cD913677553766873483ed9eEDdB77A0Bb0".toUpperCase(),
        "0x2Ccc7cD913677553766873483ed9eEDdB77A0Bb0".toLowerCase(),
      ].forEach((a: string) => {
        expect(parseAddress(a)).toBe(
          "0x2Ccc7cD913677553766873483ed9eEDdB77A0Bb0"
        );
      });
    });
    it("throws when attempting to parse a malformed address", () => {
      [
        "0x",
        // malformed mixed-case
        "0x2ccc7cD913677553766873483ed9eEDdB77A0Bb0",
        "abc123",
        "",
      ].forEach((a: string) => {
        expect(() => parseAddress(a)).toThrow(
          `not a valid ethereum address: ${a}`
        );
      });
    });
  });
  describe("truncateEthAddres", () => {
    it("creates well-formed truncated addresses", () => {
      [
        //$FlowExpectedError[incompatible-type]
        ["0x2Ccc7cD913677553766873483ed9eEDdB77A0Bb0", "0x2Ccc...0Bb0"],
        //$FlowExpectedError[incompatible-type]
        ["0xb4124cEB3451635DAcedd11767f004d8a28c6eE7", "0xb412...6eE7"],
      ].forEach(([a, t]: [EthAddress, string]) => {
        expect(truncate(a)).toBe(t);
      });
    });
  });
});
