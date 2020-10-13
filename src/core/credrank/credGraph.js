// @flow

import * as NullUtil from "../../util/null";
import {type Uuid} from "../../util/uuid";
import {type NodeAddressT, type EdgeAddressT} from "../graph";
import {
  MarkovProcessGraph,
  type MarkovProcessGraphJSON,
} from "./markovProcessGraph";
import {type MarkovEdge, type TransitionProbability} from "./markovEdge";
import {toCompat, fromCompat, type Compatible} from "../../util/compat";
import {payoutGadget} from "./edgeGadgets";

export type Node = {|
  +address: NodeAddressT,
  +description: string,
  +cred: number,
  +mint: number,
|};

export type Edge = {|
  +address: EdgeAddressT,
  +reversed: boolean,
  +src: NodeAddressT,
  +dst: NodeAddressT,
  +transitionProbability: TransitionProbability,
  +credFlow: number,
|};

export type Participant = {|
  +address: NodeAddressT,
  +description: string,
  +cred: number,
  +credPerEpoch: $ReadOnlyArray<number>,
  +id: Uuid,
|};

export type CredGraphJSON = Compatible<{|
  +mpg: MarkovProcessGraphJSON,
  // scores for each node in the same node order used by the markov process graph
  +scores: $ReadOnlyArray<number>,
|}>;

export const COMPAT_INFO = {type: "sourcecred/credGraph", version: "0.1.0"};

export class CredGraph {
  _mpg: MarkovProcessGraph;
  _scores: Map<NodeAddressT, number>;

  constructor(
    markovProcessGraph: MarkovProcessGraph,
    scores: Map<NodeAddressT, number>
  ) {
    this._mpg = markovProcessGraph;
    this._scores = scores;
  }

  _cred(addr: NodeAddressT): number {
    return NullUtil.get(this._scores.get(addr));
  }

  _credFlow(edge: MarkovEdge): number {
    const srcCred /* heh */ = this._cred(edge.src);
    return srcCred * edge.transitionProbability;
  }

  node(addr: NodeAddressT): ?Node {
    const node = this._mpg._nodes.get(addr);
    if (node == null) return undefined;
    return {...node, cred: this._cred(addr)};
  }

  *nodes(): Iterator<Node> {
    for (const node of this._mpg.nodes()) {
      yield {...node, cred: this._cred(node.address)};
    }
  }

  *edges(): Iterator<Edge> {
    for (const edge of this._mpg.edges()) {
      yield {...edge, credFlow: this._credFlow(edge)};
    }
  }

  *participants(): Iterator<Participant> {
    for (const {address, description, id} of this._mpg.participants()) {
      const epochs = this._mpg.epochBoundaries().map((epochStart) => ({
        owner: id,
        epochStart,
      }));
      let totalCred = 0;
      const credPerEpoch = epochs.map((e) => {
        const payoutAddress = payoutGadget.toRaw(e);
        const payoutMarkovEdge = NullUtil.get(this._mpg.edge(payoutAddress));
        const cred = this._credFlow(payoutMarkovEdge);
        totalCred += cred;
        return cred;
      });
      yield {address, description, credPerEpoch, cred: totalCred, id};
    }
  }

  *inNeighbors(addr: NodeAddressT): Iterator<Edge> {
    for (const edge of this._mpg.inNeighbors(addr)) {
      yield {...edge, credFlow: this._credFlow(edge)};
    }
  }

  toJSON(): CredGraphJSON {
    const mpgJson = this._mpg.toJSON();
    const nodeOrder = this._mpg.nodeOrder();
    const scores = nodeOrder.map((n) => NullUtil.get(this._scores.get(n)));
    return toCompat(COMPAT_INFO, {
      mpg: mpgJson,
      scores,
    });
  }

  static fromJSON(j: CredGraphJSON): CredGraph {
    const {mpgJson, scores} = fromCompat(COMPAT_INFO, j);
    const mpg = MarkovProcessGraph.fromJSON(mpgJson);
    const nodeOrder = mpg.nodeOrder();
    const scoresMap = new Map();
    nodeOrder.forEach((n, i) => {
      scoresMap.set(n, scores[i]);
    });
    return new CredGraph(mpg, scoresMap);
  }
}
