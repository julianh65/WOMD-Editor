import {
  AgentType,
  RoadEdge,
  ScenarioAgent,
  ScenarioBounds,
  ScenarioFrame,
  ScenarioFrameAgentState,
  TrajectoryPoint,
  WaymoScenario
} from '@/types/scenario';

type PartialScenario = {
  metadata?: Partial<WaymoScenario['metadata']>;
  agents?: unknown;
  roadEdges?: unknown;
  frames?: unknown;
};

interface RawWaymoVector2 {
  x: number;
  y: number;
}

interface RawWaymoVector3 extends RawWaymoVector2 {
  z?: number;
}

interface RawWaymoObject {
  id: number | string;
  type?: string;
  width?: number;
  length?: number;
  height?: number;
  position?: RawWaymoVector3[];
  heading?: number[];
  velocity?: RawWaymoVector2[];
  valid?: boolean[];
  goalPosition?: RawWaymoVector3;
  mark_as_expert?: boolean;
}

interface RawWaymoRoad {
  id?: number | string;
  map_element_id?: number | string;
  type?: string;
  geometry?: RawWaymoVector3[];
}

interface RawWaymoScenario {
  name?: string;
  scenario_id?: string;
  objects?: RawWaymoObject[];
  roads?: RawWaymoRoad[];
  metadata?: Record<string, unknown>;
}

const FRAME_INTERVAL_MICROS = 100_000;

const typeMap: Record<string, AgentType> = {
  vehicle: 'VEHICLE',
  car: 'VEHICLE',
  truck: 'VEHICLE',
  bus: 'VEHICLE',
  motorcycle: 'VEHICLE',
  motorcyclist: 'VEHICLE',
  pedestrian: 'PEDESTRIAN',
  cyclist: 'CYCLIST',
  bicyclist: 'CYCLIST',
  other: 'OTHER',
  unknown: 'OTHER'
};

const defaultScenario: WaymoScenario = {
  metadata: {
    id: 'untitled',
    name: 'Untitled Scenario',
    frameCount: 0,
    durationSeconds: 0,
    frameIntervalMicros: FRAME_INTERVAL_MICROS
  },
  agents: [],
  roadEdges: [],
  frames: [],
  bounds: undefined,
  raw: undefined
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWaymoFormattedScenario(value: unknown): value is RawWaymoScenario {
  if (!isObject(value)) {
    return false;
  }

  return Array.isArray((value as RawWaymoScenario).objects) || Array.isArray((value as RawWaymoScenario).roads);
}

function normaliseAgentType(rawType?: string): AgentType {
  if (!rawType) {
    return 'OTHER';
  }

  const key = rawType.toLowerCase();
  return typeMap[key] ?? 'OTHER';
}

function mapRoadType(rawType?: string): RoadEdge['type'] | undefined {
  if (!rawType) {
    return undefined;
  }

  switch (rawType.toLowerCase()) {
    case 'road_line':
      return 'ROAD_LINE';
    case 'road_edge':
      return 'ROAD_EDGE';
    case 'crosswalk':
      return 'CROSSWALK';
    default:
      return 'OTHER';
  }
}

function createTrajectoryPoints(object: RawWaymoObject, frameIntervalMicros: number): TrajectoryPoint[] {
  const positions = Array.isArray(object.position) ? object.position : [];
  const headings = Array.isArray(object.heading) ? object.heading : [];
  const velocities = Array.isArray(object.velocity) ? object.velocity : [];
  const valids = Array.isArray(object.valid) ? object.valid : [];
  const frameCount = Math.max(positions.length, headings.length, velocities.length, valids.length);

  const track: TrajectoryPoint[] = [];

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const position = positions[frameIndex];
    if (!position) {
      continue;
    }

    const velocity = velocities[frameIndex];
    const heading = headings[frameIndex];
    const isValid = valids[frameIndex];

    track.push({
      frameIndex,
      timestampMicros: frameIndex * frameIntervalMicros,
      x: position.x,
      y: position.y,
      z: position.z,
      heading,
      velocityX: velocity?.x,
      velocityY: velocity?.y,
      speed: velocity ? Math.hypot(velocity.x ?? 0, velocity.y ?? 0) : undefined,
      valid: typeof isValid === 'boolean' ? isValid : true
    });
  }

  return track;
}

function computeBoundsFromTrajectories(agents: ScenarioAgent[]): ScenarioBounds | undefined {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  let hasPoints = false;

  agents.forEach((agent) => {
    agent.trajectory.forEach((point) => {
      if (point.valid === false) {
        return;
      }

      hasPoints = true;
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    });
  });

  if (!hasPoints) {
    return undefined;
  }

  return { minX, maxX, minY, maxY };
}

function buildFrames(frameCount: number, agents: ScenarioAgent[], frameIntervalMicros: number): ScenarioFrame[] {
  if (frameCount <= 0) {
    return [];
  }

  const frames: ScenarioFrame[] = Array.from({ length: frameCount }, (_, index) => ({
    index,
    timestampMicros: index * frameIntervalMicros,
    agents: []
  }));

  agents.forEach((agent) => {
    const { id, type, dimensions } = agent;
    agent.trajectory.forEach((point) => {
      if (point.frameIndex === undefined) {
        return;
      }

      const frame = frames[point.frameIndex];
      if (!frame) {
        return;
      }

      const snapshot: ScenarioFrameAgentState = {
        id,
        type,
        x: point.x,
        y: point.y,
        z: point.z,
        heading: point.heading,
        width: dimensions?.width,
        length: dimensions?.length,
        height: dimensions?.height,
        speed: point.speed,
        velocityX: point.velocityX,
        velocityY: point.velocityY,
        valid: point.valid !== false
      };

      frame.agents.push(snapshot);
    });
  });

  return frames;
}

function parseWaymoScenario(raw: RawWaymoScenario): WaymoScenario {
  const objects = Array.isArray(raw.objects) ? raw.objects : [];
  const roads = Array.isArray(raw.roads) ? raw.roads : [];

  const frameIntervalMicros = FRAME_INTERVAL_MICROS;
  const frameCount = objects.reduce((max, object) => {
    const length = Array.isArray(object.position) ? object.position.length : 0;
    return Math.max(max, length);
  }, 0);

  const agents: ScenarioAgent[] = objects.map((object, index) => {
    const trajectory = createTrajectoryPoints(object, frameIntervalMicros);
    const id = object.id != null ? String(object.id) : `object-${index}`;

    return {
      id,
      type: normaliseAgentType(object.type),
      dimensions: object.length && object.width
        ? {
            length: object.length,
            width: object.width,
            height: object.height
          }
        : undefined,
      trajectory,
      isExpert: Boolean(object.mark_as_expert)
    };
  });

  const roadEdges: RoadEdge[] = roads.map((road, index) => ({
    id: road.id != null ? String(road.id) : road.map_element_id != null ? String(road.map_element_id) : `road-${index}`,
    points: Array.isArray(road.geometry)
      ? road.geometry.map((point) => ({ x: point.x, y: point.y }))
      : [],
    type: mapRoadType(road.type)
  }));

  const bounds = computeBoundsFromTrajectories(agents);
  const frames = buildFrames(frameCount, agents, frameIntervalMicros);

  const durationSeconds = frameCount > 0 ? ((frameCount - 1) * frameIntervalMicros) / 1_000_000 : 0;

  return {
    metadata: {
      id: raw.scenario_id || raw.name || 'untitled',
      name: raw.name || raw.scenario_id || 'Waymo Scenario',
      frameCount,
      durationSeconds,
      frameIntervalMicros
    },
    agents,
    roadEdges,
    frames,
    bounds,
    raw
  };
}

export function parseScenario(json: unknown): WaymoScenario {
  if (isWaymoFormattedScenario(json)) {
    return parseWaymoScenario(json);
  }

  if (!isObject(json)) {
    return { ...defaultScenario, raw: json };
  }

  const candidate = json as PartialScenario;

  const metadata = {
    ...defaultScenario.metadata,
    ...candidate.metadata,
    id: candidate.metadata?.id || defaultScenario.metadata.id,
    name: candidate.metadata?.name || defaultScenario.metadata.name,
    frameCount: candidate.metadata?.frameCount ?? defaultScenario.metadata.frameCount,
    durationSeconds: candidate.metadata?.durationSeconds ?? defaultScenario.metadata.durationSeconds,
    frameIntervalMicros: candidate.metadata?.frameIntervalMicros ?? defaultScenario.metadata.frameIntervalMicros
  };

  const agents = Array.isArray(candidate.agents) ? (candidate.agents as WaymoScenario['agents']) : [];
  const roadEdges = Array.isArray(candidate.roadEdges) ? (candidate.roadEdges as WaymoScenario['roadEdges']) : [];
  const frames = Array.isArray(candidate.frames) ? (candidate.frames as ScenarioFrame[]) : [];

  return {
    metadata,
    agents,
    roadEdges,
    frames,
    bounds: undefined,
    raw: json
  };
}
