// @flow
/**
 * This module contains logic for creating nodes and edges that act as "gadgets" in CredRank.
 * They are most directly used by markovProcessGraph.js
 */

import {type Uuid, fromString as uuidFromString} from "../../util/uuid";
import {type NodeAddressT, NodeAddress} from "../graph";
import type {TimestampMs} from "../../util/timestamp";
import type {MarkovNode} from "./markovNode";

export const CORE_NODE_PREFIX: NodeAddressT = NodeAddress.fromParts([
  "sourcecred",
  "core",
]);

export interface NodeGadget<T> {
  // Prefix shared by all nodes generated by this gadget.
  prefix: NodeAddressT;
  // Convert a "structured address" for nodes of this gadget into raw node addresses.
  toRaw: (T) => NodeAddressT;
  // Convert an address generated by this gadget into a structured address. Should
  // error if the address was not generated by this gadget.
  fromRaw(NodeAddressT): T;
  // Generate a full node for this gadget from the structured address.
  node: (T) => MarkovNode;
}

export const seedGadget: NodeGadget<void> = (() => {
  const description: string = "\u{1f331}"; // U+1F331 SEEDLING
  const prefix = NodeAddress.append(CORE_NODE_PREFIX, "SEED");
  const toRaw = () => prefix;
  const fromRaw = () => {};
  const node = () => ({address: prefix, description, mint: 0});
  return Object.freeze({prefix, toRaw, fromRaw, node});
})();

export type EpochAccumulatorAddress = {|
  +epochStart: TimestampMs,
|};
export const accumulatorGadget: NodeGadget<EpochAccumulatorAddress> = (() => {
  const prefix = NodeAddress.append(CORE_NODE_PREFIX, "EPOCH_ACCUMULATOR");
  function toRaw(addr) {
    return NodeAddress.append(this.prefix, String(addr.epochStart));
  }
  function fromRaw(addr) {
    if (!NodeAddress.hasPrefix(addr, this.prefix)) {
      throw new Error(
        "Not an epoch node address: " + NodeAddress.toString(addr)
      );
    }
    const prefixLength = NodeAddress.toParts(prefix).length;
    const parts = NodeAddress.toParts(addr);
    const epochStart = +parts[prefixLength];
    return {
      epochStart,
    };
  }
  function node(addr) {
    return {
      address: this.toRaw(addr),
      description: `Epoch accumulator starting ${addr.epochStart} ms past epoch`,
      mint: 0,
    };
  }
  return Object.freeze({prefix, toRaw, fromRaw, node});
})();

export type ParticipantEpochAddress = {|
  +owner: Uuid,
  +epochStart: TimestampMs,
|};
export const epochGadget: NodeGadget<ParticipantEpochAddress> = (() => {
  const prefix = NodeAddress.append(CORE_NODE_PREFIX, "USER_EPOCH");
  function toRaw(addr: ParticipantEpochAddress): NodeAddressT {
    return NodeAddress.append(prefix, String(addr.epochStart), addr.owner);
  }
  function fromRaw(addr: NodeAddressT): ParticipantEpochAddress {
    if (!NodeAddress.hasPrefix(addr, prefix)) {
      throw new Error(
        "Not an epoch node address: " + NodeAddress.toString(addr)
      );
    }
    const epochPrefixLength = NodeAddress.toParts(prefix).length;
    const parts = NodeAddress.toParts(addr).slice(epochPrefixLength);
    const epochStart = +parts[0];
    const owner = uuidFromString(parts[1]);
    return {
      owner,
      epochStart,
    };
  }
  function node(addr) {
    return {
      address: this.toRaw(addr),
      description: `Participant epoch for ${addr.owner} starting ${addr.epochStart} ms past epoch`,
      mint: 0,
    };
  }
  return Object.freeze({prefix, toRaw, fromRaw, node});
})();
