// @flow

import deepFreeze from "deep-freeze";
//import type {PluginDeclaration} from "../../analysis/pluginDeclaration";
import type {NodeType /*EdgeType*/} from "../../analysis/types";
import {
  NodeAddress,
  //EdgeAddress,
  type NodeAddressT,
  //type EdgeAddressT,
} from "../../core/graph";

export const nodePrefix: NodeAddressT = NodeAddress.fromParts([
  "sourcecred",
  "ethereum",
]);

export const ethAddressEntryType: NodeType = deepFreeze({
  name: `Ethereum Address Entry`,
  pluralName: `Ethereum Address Entries`,
  prefix: nodePrefix,
  defaultWeight: 0,
  description:
    `A Ethereum address, that can be utilized by a participant` +
    `to receive grain payouts, and linked to their identity.`,
});
