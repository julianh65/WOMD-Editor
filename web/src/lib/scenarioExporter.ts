import {
  ScenarioAgent,
  ScenarioBounds,
  ScenarioFrame,
  ScenarioFrameAgentState,
  TrajectoryPoint,
  WaymoScenario
} from '@/types/scenario';

export interface ScenarioExportPayload {
  version: number;
  exportedAt: string;
  metadata: WaymoScenario['metadata'];
  bounds?: ScenarioBounds;
  agents: ScenarioAgent[];
  tracksToPredict: number[];
  roadEdges: WaymoScenario['roadEdges'];
  frames: ScenarioFrame[];
}

function cloneTrajectory(trajectory: TrajectoryPoint[]): TrajectoryPoint[] {
  return [...trajectory]
    .map((point) => ({ ...point }))
    .sort((a, b) => {
      const aIndex = a.frameIndex ?? 0;
      const bIndex = b.frameIndex ?? 0;
      return aIndex - bIndex;
    });
}

function cloneAgents(agents: ScenarioAgent[]): ScenarioAgent[] {
  return agents.map((agent) => ({
    ...agent,
    trajectory: cloneTrajectory(agent.trajectory)
  }));
}

function cloneRoadEdges(edges: WaymoScenario['roadEdges']): WaymoScenario['roadEdges'] {
  return edges.map((edge) => ({
    ...edge,
    points: edge.points.map((point) => ({ x: point.x, y: point.y }))
  }));
}

function cloneFrames(frames: ScenarioFrame[]): ScenarioFrame[] {
  return frames.map((frame) => ({
    ...frame,
    agents: frame.agents.map((agentState) => ({ ...agentState })) as ScenarioFrameAgentState[]
  }));
}

type WaymoVector3 = { x: number; y: number; z: number };
type WaymoVelocity = { x: number; y: number };

interface WaymoExportObject {
  id: number | string;
  type: string;
  length?: number;
  width?: number;
  height?: number;
  position: WaymoVector3[];
  heading: number[];
  velocity: WaymoVelocity[];
  valid: boolean[];
  mark_as_expert?: boolean;
  goalPosition?: WaymoVector3;
}

interface WaymoExportRoad {
  id: number | string;
  map_element_id?: number | string;
  type?: string;
  geometry: WaymoVector3[];
}

export interface WaymoScenarioExportPayload {
  name: string;
  scenario_id: string;
  objects: WaymoExportObject[];
  roads: WaymoExportRoad[];
  tracks_to_predict?: Array<number | string>;
  tl_states: unknown[];
  metadata?: Record<string, unknown>;
}

const AGENT_TYPE_TO_RAW: Record<string, string> = {
  VEHICLE: 'vehicle',
  PEDESTRIAN: 'pedestrian',
  CYCLIST: 'cyclist',
  OTHER: 'other'
};

const ROAD_TYPE_TO_RAW: Record<string, string> = {
  ROAD_LINE: 'road_line',
  ROAD_EDGE: 'road_edge',
  CROSSWALK: 'crosswalk',
  OTHER: 'other'
};

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function toIdentifier(value: string): number | string {
  const maybeNumber = toFiniteNumber(value);
  return maybeNumber ?? value;
}

type NormalisedTrajectoryPoint = TrajectoryPoint & { frameIndex: number };

function normaliseTrajectoryPoints(points: TrajectoryPoint[]): NormalisedTrajectoryPoint[] {
  const normalised = points.map((point, index) => {
    const fallbackIndex = index;
    const normalisedIndex = typeof point.frameIndex === 'number' && Number.isFinite(point.frameIndex)
      ? Math.max(0, Math.floor(point.frameIndex))
      : fallbackIndex;

    return {
      ...point,
      frameIndex: normalisedIndex
    };
  }).sort((a, b) => a.frameIndex - b.frameIndex);

  return normalised;
}

function mapAgentToWaymoObject(agent: ScenarioAgent): WaymoExportObject {
  const trajectory = normaliseTrajectoryPoints(agent.trajectory);

  const position: WaymoVector3[] = trajectory.map((point) => ({
    x: point.x,
    y: point.y,
    z: typeof point.z === 'number' && Number.isFinite(point.z) ? point.z : 0
  }));

  const heading: number[] = trajectory.map((point) => (
    typeof point.heading === 'number' && Number.isFinite(point.heading)
      ? point.heading
      : 0
  ));

  const velocity: WaymoVelocity[] = trajectory.map((point) => ({
    x: typeof point.velocityX === 'number' && Number.isFinite(point.velocityX)
      ? point.velocityX
      : (typeof point.speed === 'number' && typeof point.heading === 'number'
          ? point.speed * Math.cos(point.heading)
          : 0),
    y: typeof point.velocityY === 'number' && Number.isFinite(point.velocityY)
      ? point.velocityY
      : (typeof point.speed === 'number' && typeof point.heading === 'number'
          ? point.speed * Math.sin(point.heading)
          : 0)
  }));

  const valid: boolean[] = trajectory.map((point) => point.valid !== false);

  const id = toIdentifier(agent.id);
  const length = toFiniteNumber(agent.dimensions?.length);
  const width = toFiniteNumber(agent.dimensions?.width);
  const height = toFiniteNumber(agent.dimensions?.height);
  const type = AGENT_TYPE_TO_RAW[agent.type] ?? 'other';
  const lastValidPoint = [...trajectory].reverse().find((point) => point.valid !== false);

  return {
    id,
    type,
    length: length ?? undefined,
    width: width ?? undefined,
    height: height ?? undefined,
    position,
    heading,
    velocity,
    valid,
    mark_as_expert: agent.isExpert ? true : undefined,
    goalPosition: lastValidPoint
      ? {
          x: lastValidPoint.x,
          y: lastValidPoint.y,
          z: typeof lastValidPoint.z === 'number' && Number.isFinite(lastValidPoint.z) ? lastValidPoint.z : 0
        }
      : undefined
  };
}

function mapRoadToWaymoRoad(edge: WaymoScenario['roadEdges'][number]): WaymoExportRoad {
  const id = toIdentifier(edge.id);
  const mapElementId = toIdentifier(edge.id);
  const type = edge.type ? ROAD_TYPE_TO_RAW[edge.type] ?? 'other' : undefined;

  return {
    id,
    map_element_id: mapElementId,
    type,
    geometry: edge.points.map((point) => ({
      x: point.x,
      y: point.y,
      z: 0
    }))
  };
}

function cloneIfObject<T>(value: T): T {
  if (!value || typeof value !== 'object') {
    return value;
  }

  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (_error) {
    return value;
  }
}

function buildWaymoMetadata(scenario: WaymoScenario, exportedAt: string): Record<string, unknown> | undefined {
  const raw = cloneIfObject(scenario.raw) as Record<string, unknown> | undefined;
  const baseMetadata = raw && typeof raw.metadata === 'object'
    ? { ...(raw.metadata as Record<string, unknown>) }
    : {};

  if (scenario.tracksToPredict.length > 0) {
    baseMetadata.tracks_to_predict = [...scenario.tracksToPredict];
  }

  if (scenario.bounds) {
    baseMetadata.bounds = { ...scenario.bounds };
  }

  if (scenario.metadata.frameIntervalMicros != null) {
    baseMetadata.frame_interval_micros = scenario.metadata.frameIntervalMicros;
  }

  baseMetadata.frame_count = scenario.metadata.frameCount;
  baseMetadata.duration_seconds = scenario.metadata.durationSeconds;
  baseMetadata.editor_exported_at = exportedAt;

  return Object.keys(baseMetadata).length > 0 ? baseMetadata : undefined;
}

export function buildWaymoScenarioExportPayload(scenario: WaymoScenario, options?: { exportedAt?: string }): WaymoScenarioExportPayload {
  const exportedAt = options?.exportedAt ?? new Date().toISOString();

  const tlStates = (() => {
    const raw = cloneIfObject(scenario.raw) as Record<string, unknown> | undefined;
    if (raw && Array.isArray(raw.tl_states)) {
      return cloneIfObject(raw.tl_states) as unknown[];
    }
    return [];
  })();

  return {
    name: scenario.metadata.name ?? 'Scenario',
    scenario_id: scenario.metadata.id ?? 'untitled',
    objects: scenario.agents.map(mapAgentToWaymoObject),
    roads: scenario.roadEdges.map(mapRoadToWaymoRoad),
    tracks_to_predict: scenario.tracksToPredict.length > 0 ? [...scenario.tracksToPredict] : undefined,
    tl_states: tlStates,
    metadata: buildWaymoMetadata(scenario, exportedAt)
  };
}

export function buildScenarioExportPayload(scenario: WaymoScenario): ScenarioExportPayload {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    metadata: { ...scenario.metadata },
    bounds: scenario.bounds ? { ...scenario.bounds } : undefined,
    agents: cloneAgents(scenario.agents),
    tracksToPredict: [...scenario.tracksToPredict],
    roadEdges: cloneRoadEdges(scenario.roadEdges),
    frames: cloneFrames(scenario.frames)
  };
}

function sanitizeFileName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_.-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'scenario';
}

export function downloadScenarioAsJson(
  scenario: WaymoScenario,
  options?: { fileName?: string }
): void {
  if (typeof window === 'undefined') {
    return;
  }

  const exportedAt = new Date().toISOString();
  const payload = buildWaymoScenarioExportPayload(scenario, { exportedAt });
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const fileName = sanitizeFileName(options?.fileName ?? scenario.metadata.name ?? 'scenario');

  anchor.href = url;
  anchor.download = `${fileName}.json`;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
