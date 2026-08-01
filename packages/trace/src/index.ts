// SPDX-License-Identifier: Apache-2.0
export {
  Usage,
  TraceSource,
  KNOWN_TRACE_SOURCES,
  type KnownTraceSource,
  RunStarted,
  NodeStarted,
  NodeLog,
  NodeFinished,
  NodeFailed,
  GateWaiting,
  GateResolved,
  RunFinished,
  TraceEvent,
  type TraceEventType,
} from "./schema.js";

export {
  parseTraceLine,
  serializeEvent,
  isTraceEvent,
  type TraceLine,
  type UnknownTraceLine,
} from "./codec.js";

export {
  reduceRun,
  emptyRunState,
  TAIL_CAP,
  type RunState,
  type RunStatus,
  type NodeRunState,
  type NodeStatus,
  type InstanceCounts,
} from "./reduce.js";

export {
  HeatData,
  statsFromLines,
  heatFromRunStats,
  type Aggregate,
  type RunStats,
  type TraceHeatMetric,
} from "./stats.js";
