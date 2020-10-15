// @flow

import deepFreeze from "deep-freeze";
import {type Uuid} from "../../util/uuid";

/**
 * Data structure representing a particular kind of Markov process, as
 * kind of a middle ground between the semantic SourceCred graph (in the
 * `core/graph` module) and a literal transition matrix. Unlike the core
 * graph, edges in a Markov process graph are unidirectional, edge
 * weights are raw transition probabilities (which must sum to 1) rather
 * than unnormalized weights, and there are no dangling edges. Unlike a
 * fully general transition matrix, parallel edges are still reified,
 * not collapsed; nodes have weights, representing sources of flow; and
 * a few SourceCred-specific concepts are made first-class:
 * specifically, cred minting and time period fibration. The
 * "teleportation vector" from PageRank is also made explicit via the
 * "adjoined seed node" graph transformation strategy, so this data
 * structure can form well-defined Markov processes even from graphs
 * with nodes with no out-weight. Because the graph reifies the
 * teleportation and temporal fibration, the associated parameters are
 * "baked in" to weights of the Markov process graph.
 *
 * We use the term "fibration" to refer to a graph transformation where
 * each scoring node is split into one node per epoch, and incident
 * edges are rewritten to point to the appropriate epoch nodes. The term
 * is vaguely inspired from the notion of a fiber bundle, though the
 * analogy is not precise.
 *
 * The Markov process graphs in this module have three kinds of nodes:
 *
 *   - *base nodes*, which are in 1-to-1 correspondence with the nodes
 *     in the underlying core graph that are not scoring nodes;
 *   - *user-epoch nodes*, which are created for each time period for
 *     each scoring node; and
 *   - *epoch accumulators*, which are created once for each epoch to
 *     aggregate over the epoch nodes,
 *   - the *seed node*, which reifies the teleportation vector and
 *     forces well-definedness and ergodicity of the Markov process (for
 *     nonzero alpha, and assuming that there is at least one edge in
 *     the underlying graph).
 *
 * The edges include:
 *
 *   - *base edges* due to edges in the underlying graph, whose
 *     endpoints are lifted to the corresponding base nodes or to
 *     user-epoch nodes for endpoints that have been fibrated;
 *   - *radiation edges* edges from nodes to the seed node;
 *   - *minting edges* from the seed node to cred-minting nodes;
 *   - *webbing edges* between temporally adjacent user-epoch nodes; and
 *   - *payout edges* from a user-epoch node to the accumulator for its
 *     epoch.
 *
 * A Markov process graph can be converted to a pure Markov chain for
 * spectral analysis via the `toMarkovChain` method.
 */

import sortedIndex from "lodash.sortedindex";
import sortBy from "../../util/sortBy";
import {type NodeAddressT, NodeAddress, type EdgeAddressT} from "../graph";
import {type WeightedGraph as WeightedGraphT} from "../weightedGraph";
import {
  nodeWeightEvaluator,
  edgeWeightEvaluator,
} from "../algorithm/weightEvaluator";
import {toCompat, fromCompat, type Compatible} from "../../util/compat";
import * as NullUtil from "../../util/null";
import * as MapUtil from "../../util/map";
import type {TimestampMs} from "../../util/timestamp";
import {type SparseMarkovChain} from "../algorithm/markovChain";
import {type IntervalSequence} from "../interval";

import {type MarkovNode} from "./markovNode";

import {
  type MarkovEdge,
  type MarkovEdgeAddressT,
  type TransitionProbability,
  MarkovEdgeAddress,
  markovEdgeAddressFromMarkovEdge,
} from "./markovEdge";

import {
  seedGadget,
  accumulatorGadget,
  epochGadget,
  CORE_NODE_PREFIX,
} from "./nodeGadgets";

import {
  accumulatorRadiationGadget,
  epochRadiationGadget,
  contributionRadiationGadget,
  seedMintGadget,
  payoutGadget,
  forwardWebbingGadget,
  backwardWebbingGadget,
} from "./edgeGadgets";

export type Participant = {|
  +address: NodeAddressT,
  +description: string,
  +id: Uuid,
|};

export type OrderedSparseMarkovChain = {|
  +nodeOrder: $ReadOnlyArray<NodeAddressT>,
  +chain: SparseMarkovChain,
|};

export type Arguments = {|
  +weightedGraph: WeightedGraphT,
  +participants: $ReadOnlyArray<Participant>,
  +intervals: IntervalSequence,
  +parameters: Parameters,
|};

export type Parameters = {|
  // Transition probability from every organic node back to the seed node.
  +alpha: TransitionProbability,
  // Transition probability for payout edges from epoch nodes to their
  // owners.
  +beta: TransitionProbability,
  // Transition probability for webbing edges from an epoch node to the
  // next epoch node for the same owner.
  +gammaForward: TransitionProbability,
  +gammaBackward: TransitionProbability,
|};

export const COMPAT_INFO = {
  type: "sourcecred/markovProcessGraph",
  version: "0.1.0",
};

// A MarkovEdge in which the src and dst have been replaced with indices instead
// of full addresses. The indexing is based on the order of nodes in the MarkovProcessGraphJSON.
export type IndexedMarkovEdge = {|
  +address: EdgeAddressT,
  +reversed: boolean,
  +src: number,
  +dst: number,
  +transitionProbability: TransitionProbability,
|};
export type MarkovProcessGraphJSON = Compatible<{|
  +sortedNodes: $ReadOnlyArray<MarkovNode>,
  +indexedEdges: $ReadOnlyArray<IndexedMarkovEdge>,
  +participants: $ReadOnlyArray<Participant>,
  // The -Infinity and +Infinity epoch boundaries must be stripped before
  // JSON serialization.
  +finiteEpochBoundaries: $ReadOnlyArray<number>,
|}>;

export class MarkovProcessGraph {
  _nodes: Map<NodeAddressT, MarkovNode>;
  _edges: Map<MarkovEdgeAddressT, MarkovEdge>;
  _participants: $ReadOnlyArray<Participant>;
  _epochBoundaries: $ReadOnlyArray<number>;

  constructor(
    nodes: Map<NodeAddressT, MarkovNode>,
    edges: Map<MarkovEdgeAddressT, MarkovEdge>,
    participants: $ReadOnlyArray<Participant>,
    epochBoundaries: $ReadOnlyArray<number>
  ) {
    this._nodes = nodes;
    this._edges = edges;
    this._epochBoundaries = deepFreeze(epochBoundaries);
    this._participants = deepFreeze(participants);
  }

  static new(args: Arguments): MarkovProcessGraph {
    const {weightedGraph, participants, parameters, intervals} = args;
    const {alpha, beta, gammaForward, gammaBackward} = parameters;
    const _nodes = new Map();
    const _edges = new Map();

    const _scoringAddressToId = new Map(
      participants.map((p) => [p.address, p.id])
    );
    const _scoringAddresses = new Set(participants.map((p) => p.address));

    // _nodeOutMasses[a] = sum(e.pr for e in edges if e.src == a)
    // Used for computing remainder-to-seed edges.
    const _nodeOutMasses = new Map();

    // Amount of mass allocated to contribution edges flowing from epoch
    // nodes.
    const epochTransitionRemainder: number = (() => {
      const valid = (x) => x >= 0 && x <= 1;
      if (
        !valid(beta) ||
        !valid(gammaForward) ||
        !valid(gammaBackward) ||
        !valid(alpha)
      ) {
        throw new Error(
          "Invalid transition probability: " +
            [beta, gammaForward, gammaBackward, alpha].join(" or ")
        );
      }
      const result = 1 - (alpha + beta + gammaForward + gammaBackward);
      if (result < 0) {
        throw new Error("Overlarge transition probability: " + (1 - result));
      }
      return result;
    })();

    const timeBoundaries = [
      -Infinity,
      ...intervals.map((x) => x.startTimeMs),
      Infinity,
    ];

    const addNode = (node: MarkovNode) => {
      if (_nodes.has(node.address)) {
        throw new Error("Node conflict: " + node.address);
      }
      _nodes.set(node.address, node);
    };
    const addEdge = (edge: MarkovEdge) => {
      const mae = markovEdgeAddressFromMarkovEdge(edge);
      if (_edges.has(mae)) {
        throw new Error("Edge conflict: " + mae);
      }
      const pr = edge.transitionProbability;
      if (pr < 0 || pr > 1) {
        const name = MarkovEdgeAddress.toString(mae);
        throw new Error(`Invalid transition probability for ${name}: ${pr}`);
      }
      _edges.set(mae, edge);
      _nodeOutMasses.set(edge.src, (_nodeOutMasses.get(edge.src) || 0) + pr);
    };

    // Add graph nodes
    const nwe = nodeWeightEvaluator(weightedGraph.weights);
    for (const node of weightedGraph.graph.nodes()) {
      if (_scoringAddresses.has(node.address)) {
        // Scoring nodes are not included in the Markov process graph:
        // the cred for a scoring node is given implicitly by the
        // weight-sum of its epoch accumulation edges.
        continue;
      }
      const weight = nwe(node.address);
      if (weight < 0 || !Number.isFinite(weight)) {
        const name = NodeAddress.toString(node.address);
        throw new Error(`Bad node weight for ${name}: ${weight}`);
      }
      if (NodeAddress.hasPrefix(node.address, CORE_NODE_PREFIX)) {
        throw new Error(
          "Unexpected core node in underlying graph: " +
            NodeAddress.toString(node.address)
        );
      }
      addNode({
        address: node.address,
        description: node.description,
        mint: weight,
      });
    }

    // Add epoch nodes, epoch accumulators, payout edges, and epoch webbing
    let lastBoundary = null;
    for (const boundary of timeBoundaries) {
      for (const participant of participants) {
        const thisEpoch = {
          owner: participant.id,
          epochStart: boundary,
        };
        addNode(epochGadget.node(thisEpoch));
        addEdge(payoutGadget.markovEdge(thisEpoch, beta));
        if (lastBoundary != null) {
          const webbingAddress = {
            thisStart: boundary,
            lastStart: lastBoundary,
            owner: participant.id,
          };
          addEdge(
            forwardWebbingGadget.markovEdge(webbingAddress, gammaForward)
          );
          addEdge(
            backwardWebbingGadget.markovEdge(webbingAddress, gammaBackward)
          );
        }
        lastBoundary = boundary;
      }
    }

    // Add minting edges, from the seed to positive-weight graph nodes
    {
      let totalNodeWeight = 0.0;
      const positiveNodeWeights: Map<NodeAddressT, number> = new Map();
      for (const {address, mint} of _nodes.values()) {
        if (mint > 0) {
          totalNodeWeight += mint;
          positiveNodeWeights.set(address, mint);
        }
      }
      if (!(totalNodeWeight > 0)) {
        throw new Error("No outflow from seed; add cred-minting nodes");
      }
      for (const [address, weight] of positiveNodeWeights) {
        addEdge(seedMintGadget.markovEdge(address, weight / totalNodeWeight));
      }
    }

    /**
     * Find an epoch node, or just the original node if it's not a
     * scoring address.
     */
    const rewriteEpochNode = (
      address: NodeAddressT,
      edgeTimestampMs: TimestampMs
    ): NodeAddressT => {
      const owner = _scoringAddressToId.get(address);
      if (owner == null) {
        return address;
      }
      const epochEndIndex = sortedIndex(timeBoundaries, edgeTimestampMs);
      const epochStartIndex = epochEndIndex - 1;
      const epochTimestampMs = timeBoundaries[epochStartIndex];
      return epochGadget.toRaw({
        owner,
        epochStart: epochTimestampMs,
      });
    };

    // Add graph edges. First, split by direction.
    type _UnidirectionalGraphEdge = {|
      +address: EdgeAddressT,
      +reversed: boolean,
      +src: NodeAddressT,
      +dst: NodeAddressT,
      +timestamp: TimestampMs,
      +weight: number,
    |};
    const unidirectionalGraphEdges = function* (): Iterator<_UnidirectionalGraphEdge> {
      const ewe = edgeWeightEvaluator(weightedGraph.weights);
      for (const edge of (function* () {
        for (const edge of weightedGraph.graph.edges({showDangling: false})) {
          const weight = ewe(edge.address);
          yield {
            address: edge.address,
            reversed: false,
            src: edge.src,
            dst: edge.dst,
            timestamp: edge.timestampMs,
            weight: weight.forwards,
          };
          yield {
            address: edge.address,
            reversed: true,
            src: edge.dst,
            dst: edge.src,
            timestamp: edge.timestampMs,
            weight: weight.backwards,
          };
        }
      })()) {
        if (edge.weight > 0) {
          yield edge;
        }
      }
    };

    const srcNodes: Map<
      NodeAddressT /* domain: nodes with positive weight from base edges */,
      {totalOutWeight: number, outEdges: _UnidirectionalGraphEdge[]}
    > = new Map();
    for (const graphEdge of unidirectionalGraphEdges()) {
      const src = rewriteEpochNode(graphEdge.src, graphEdge.timestamp);
      let datum = srcNodes.get(src);
      if (datum == null) {
        datum = {totalOutWeight: 0, outEdges: []};
        srcNodes.set(src, datum);
      }
      datum.totalOutWeight += graphEdge.weight;
      datum.outEdges.push(graphEdge);
    }
    for (const [src, {totalOutWeight, outEdges}] of srcNodes) {
      const totalOutPr = NodeAddress.hasPrefix(src, epochGadget.prefix)
        ? epochTransitionRemainder
        : 1 - alpha;
      for (const outEdge of outEdges) {
        const pr = (outEdge.weight / totalOutWeight) * totalOutPr;
        addEdge({
          address: outEdge.address,
          reversed: outEdge.reversed,
          src: rewriteEpochNode(outEdge.src, outEdge.timestamp),
          dst: rewriteEpochNode(outEdge.dst, outEdge.timestamp),
          transitionProbability: pr,
        });
      }
    }

    function* realAndVirtualNodes(): Iterator<MarkovNode> {
      for (const node of _nodes.values()) {
        yield node;
      }
      for (const nodeAddress of virtualizedNodeAddresses(timeBoundaries)) {
        yield NullUtil.get(virtualizedNode(nodeAddress));
      }
    }

    // Add radiation edges
    for (const node of realAndVirtualNodes()) {
      const transitionProbability =
        1 - NullUtil.orElse(_nodeOutMasses.get(node.address), 0);
      if (node.address === seedGadget.prefix) continue;
      if (NodeAddress.hasPrefix(node.address, epochGadget.prefix)) {
        const target = epochGadget.fromRaw(node.address);
        addEdge(epochRadiationGadget.markovEdge(target, transitionProbability));
      } else if (
        NodeAddress.hasPrefix(node.address, accumulatorGadget.prefix)
      ) {
        const target = accumulatorGadget.fromRaw(node.address);
        addEdge(
          accumulatorRadiationGadget.markovEdge(target, transitionProbability)
        );
      } else if (NodeAddress.hasPrefix(node.address, CORE_NODE_PREFIX)) {
        throw new Error(
          "invariant violation: unknown core node: " +
            NodeAddress.toString(node.address)
        );
      } else {
        addEdge(
          contributionRadiationGadget.markovEdge(
            node.address,
            transitionProbability
          )
        );
      }
    }

    return new MarkovProcessGraph(_nodes, _edges, participants, timeBoundaries);
  }

  epochBoundaries(): $ReadOnlyArray<number> {
    return this._epochBoundaries;
  }

  participants(): $ReadOnlyArray<Participant> {
    return this._participants;
  }

  /**
   * Returns a canonical ordering of the nodes in the graph.
   *
   * No assumptions should be made about the node order, other than
   * that it is stable for any given MarkovProcessGraph.
   */
  nodeOrder(): $ReadOnlyArray<NodeAddressT> {
    const real = Array.from(this._nodes.keys()).sort();
    const virtual = Array.from(virtualizedNodeAddresses(this._epochBoundaries));
    return [...real, ...virtual];
  }

  node(address: NodeAddressT): MarkovNode | null {
    NodeAddress.assertValid(address);
    return this._nodes.get(address) || virtualizedNode(address);
  }

  /**
   * Iterate over the nodes in the graph. If a prefix is provided,
   * only nodes matching that prefix will be returned.
   *
   * The nodes are always iterated over in the node order.
   */
  *nodes(options?: {|+prefix: NodeAddressT|}): Iterator<MarkovNode> {
    const prefix = options ? options.prefix : NodeAddress.empty;
    for (const address of this.nodeOrder()) {
      if (NodeAddress.hasPrefix(address, prefix)) {
        yield NullUtil.get(this.node(address));
      }
    }
  }

  /**
   * Returns a canonical ordering of the edges in the graph.
   *
   * No assumptions should be made about the edge order, other than
   * that it is stable for any given MarkovProcessGraph.
   */
  edgeOrder(): $ReadOnlyArray<MarkovEdgeAddressT> {
    return Array.from(this._edges.keys()).sort();
  }

  edge(address: MarkovEdgeAddressT): MarkovEdge | null {
    MarkovEdgeAddress.assertValid(address);
    return this._edges.get(address) || null;
  }

  /**
   * Iterate over the edges in the graph.
   *
   * The edges are always iterated over in the edge order.
   */
  *edges(): Iterator<MarkovEdge> {
    for (const addr of this.edgeOrder()) {
      yield NullUtil.get(this.edge(addr));
    }
  }

  *inNeighbors(nodeAddress: NodeAddressT): Iterator<MarkovEdge> {
    for (const edge of this.edges()) {
      if (edge.dst !== nodeAddress) {
        continue;
      }
      yield edge;
    }
  }

  toMarkovChain(): OrderedSparseMarkovChain {
    // Array-ify the iterators so we can iterate over them multiple times
    // without needing to re-generate them.
    const nodes = Array.from(this.nodes());
    const edges = Array.from(this.edges());
    const nodeIndex: Map<
      NodeAddressT,
      number /* index into nodeOrder */
    > = new Map();
    nodes.forEach((n, i) => {
      nodeIndex.set(n.address, i);
    });

    // Check that out-edges sum to about 1.
    const nodeOutMasses = new Map();
    for (const {address} of nodes) {
      nodeOutMasses.set(address, 0);
    }
    for (const edge of edges) {
      const a = edge.src;
      nodeOutMasses.set(
        a,
        NullUtil.get(nodeOutMasses.get(a)) + edge.transitionProbability
      );
    }
    for (const [node, outMass] of nodeOutMasses) {
      const discrepancy = outMass - 1;
      if (Math.abs(discrepancy) > 1e-3) {
        const name = NodeAddress.toString(node);
        throw new Error(
          `Transition weights for ${name} do not sum to 1.0: ${outMass}`
        );
      }
    }

    const inNeighbors: Map<NodeAddressT, MarkovEdge[]> = new Map();
    for (const edge of edges) {
      MapUtil.pushValue(inNeighbors, edge.dst, edge);
    }

    const chain = nodes.map(({address}) => {
      const inEdges = NullUtil.orElse(inNeighbors.get(address), []);
      const inDegree = inEdges.length;
      const neighbor = new Uint32Array(inDegree);
      const weight = new Float64Array(inDegree);
      inEdges.forEach((e, i) => {
        // Note: We don't group-by src, so there may be multiple `j`
        // such that `neighbor[j] === k` for a given `k` when there are
        // parallel edges in the source graph. This should just work
        // down the stack.
        const srcIndex = nodeIndex.get(e.src);
        if (srcIndex == null) {
          throw new Error(e.src);
        }
        neighbor[i] = srcIndex;
        weight[i] = e.transitionProbability;
      });
      return {neighbor, weight};
    });

    return {nodeOrder: nodes.map((x) => x.address), chain};
  }

  toJSON(): MarkovProcessGraphJSON {
    const nodes = Array.from(this._nodes.values());
    const edges = Array.from(this._edges.values());
    // Sort the nodes and edges just to ensure that the serialization for identical graphs is
    // identical.
    const sortedNodes = sortBy(nodes, (n) => n.address);
    const sortedEdges = sortBy(edges, (e) =>
      markovEdgeAddressFromMarkovEdge(e)
    );
    const nodeIndex: Map<
      NodeAddressT,
      number /* index into nodeOrder */
    > = new Map();
    this.nodeOrder().forEach((address, i) => {
      nodeIndex.set(address, i);
    });
    const indexedEdges = Array.from(sortedEdges).map((e) => ({
      address: e.address,
      reversed: e.reversed,
      src: NullUtil.get(nodeIndex.get(e.src)),
      dst: NullUtil.get(nodeIndex.get(e.dst)),
      transitionProbability: e.transitionProbability,
    }));
    return toCompat(COMPAT_INFO, {
      sortedNodes,
      indexedEdges,
      participants: this._participants,
      finiteEpochBoundaries: this._epochBoundaries.slice(
        1,
        this._epochBoundaries.length - 1
      ),
    });
  }

  static fromJSON(j: MarkovProcessGraphJSON): MarkovProcessGraph {
    const {
      sortedNodes,
      indexedEdges,
      participants,
      finiteEpochBoundaries,
    } = fromCompat(COMPAT_INFO, j);
    const epochBoundaries = [-Infinity, ...finiteEpochBoundaries, Infinity];
    const sortedNodeAddresses = [
      ...sortedNodes.map((n) => n.address),
      ...virtualizedNodeAddresses(epochBoundaries),
    ];
    const edges = indexedEdges.map((e) => ({
      address: e.address,
      reversed: e.reversed,
      src: sortedNodeAddresses[e.src],
      dst: sortedNodeAddresses[e.dst],
      transitionProbability: e.transitionProbability,
    }));

    return new MarkovProcessGraph(
      new Map(sortedNodes.map((n) => [n.address, n])),
      new Map(edges.map((e) => [markovEdgeAddressFromMarkovEdge(e), e])),
      participants,
      epochBoundaries
    );
  }
}

/**
 * Return an array containing the node addresses for every
 * virtualized node. The order must be stable.
 */
function* virtualizedNodeAddresses(
  epochBoundaries: $ReadOnlyArray<TimestampMs>
): Iterable<NodeAddressT> {
  yield seedGadget.prefix;
  for (const epochStart of epochBoundaries) {
    yield accumulatorGadget.toRaw({epochStart});
  }
}

function virtualizedNode(address: NodeAddressT): MarkovNode | null {
  if (NodeAddress.hasPrefix(address, seedGadget.prefix)) {
    return seedGadget.node();
  }
  if (NodeAddress.hasPrefix(address, accumulatorGadget.prefix)) {
    return accumulatorGadget.node(accumulatorGadget.fromRaw(address));
  }
  return null;
}
