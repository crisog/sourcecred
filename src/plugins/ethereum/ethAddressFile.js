// @flow

import {isAddress, toChecksumAddress} from "web3-utils";

import * as C from "../../util/combo";
import {JsonLog} from "../../util/jsonLog";
import {compatibleParser} from "../../util/compat";

//import type {Name} from "../../core/identity";
export opaque type EthAddress: string = string;

export function parseAddress(s: string): EthAddress {
  if (!isAddress(s)) {
    throw new Error(`not a valid ethereum address: ${s}`);
  }
  return toChecksumAddress(s);
}

// Utilized for a more readable and recognizable address. This is
// needed to allow the address to fit within the Identity name requirements
export function truncateEthAddress(address: EthAddress): string {
  const prefix = address.slice(0, 6);
  const suffix = address.slice(-4);
  return `${prefix}...${suffix}`;
}

export const ethAddressParser: C.Parser<EthAddress> = (C.fmap(
  C.string,
  parseAddress
): C.Parser<EthAddress>);

const COMPAT_INFO = {type: "sourcecred/ethAddressFile", version: "0.0.1"};

type AddressEntriesJSON = JsonLog<EthAddress>;

const addressEntriesParser = C.fmap(C.string, (s: string) =>
  JsonLog.fromString(s, ethAddressParser)
);

export const parser: C.Parser<AddressEntriesJSON> = compatibleParser(
  COMPAT_INFO.type,
  {"0.0.1": addressEntriesParser}
);
