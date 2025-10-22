import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren
} from 'react';
import { parseScenario } from '@/lib/scenarioParser';
import {
  ScenarioAgent,
  ScenarioBounds,
  ScenarioFrame,
  ScenarioFrameAgentState,
  TrajectoryPoint,
  WaymoScenario
} from '@/types/scenario';

export type EditingMode = 'trajectory' | 'road';
export type EditingTool = 'select' | 'trajectory-record' | 'trajectory-drive' | 'trajectory-edit' | 'road-add' | 'road-edit';
export type EditingEntityKind = 'agent' | 'roadEdge';

export interface EditingEntityRef {
  kind: EditingEntityKind;
  id: string;
}

export interface TrajectorySample {
  x: number;
  y: number;
  timestampMs: number;
}

export interface TrajectoryDraft {
  agentId: string;
  startedAtMs: number;
  lastSampledAtMs: number;
  samples: TrajectorySample[];
}

export interface EditingHistoryEntry {
  id: string;
  label: string;
  timestamp: number;
}

interface EditingHistoryState {
  undoStack: EditingHistoryEntry[];
  redoStack: EditingHistoryEntry[];
}

export interface EditingState {
  mode: EditingMode;
  activeTool: EditingTool;
  hoveredEntity?: EditingEntityRef;
  selectedEntity?: EditingEntityRef;
  isRecording: boolean;
  trajectoryDraft?: TrajectoryDraft;
  history: EditingHistoryState;
}

function createInitialEditingState(): EditingState {
  return {
    mode: 'trajectory',
    activeTool: 'trajectory-edit',
    hoveredEntity: undefined,
    selectedEntity: undefined,
    isRecording: false,
    trajectoryDraft: undefined,
    history: {
      undoStack: [],
      redoStack: []
    }
  };
}

function computeBoundsFromAgents(agents: ScenarioAgent[]): ScenarioBounds | undefined {
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

function buildFramesFromAgents(
  agents: ScenarioAgent[],
  frameIntervalMicros: number,
  frameCountOverride?: number
): ScenarioFrame[] {
  const computedFrameCount = agents.reduce((max, agent) => {
    const agentFrameCount = agent.trajectory.reduce((innerMax, point) => {
      if (typeof point.frameIndex === 'number') {
        return Math.max(innerMax, point.frameIndex + 1);
      }
      return innerMax;
    }, 0);
    return Math.max(max, agentFrameCount);
  }, 0);

  const frameCount = frameCountOverride != null
    ? Math.max(frameCountOverride, computedFrameCount)
    : computedFrameCount;

  if (frameCount <= 0) {
    return [];
  }

  const frames: ScenarioFrame[] = Array.from({ length: frameCount }, (_, index) => ({
    index,
    timestampMicros: index * frameIntervalMicros,
    agents: [] as ScenarioFrameAgentState[]
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

      frame.agents.push({
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
      });
    });
  });

  return frames;
}

function withScenarioRebuild(base: WaymoScenario, nextAgents: ScenarioAgent[]): WaymoScenario {
  const frameInterval = base.metadata.frameIntervalMicros ?? DEFAULT_FRAME_INTERVAL_MICROS;
  const fallbackFrameCount = Math.max(base.metadata.frameCount, base.frames.length, 1);
  const overrideFrameCount = nextAgents.length === 0 ? fallbackFrameCount : undefined;
  const frames = buildFramesFromAgents(nextAgents, frameInterval, overrideFrameCount);
  const frameCount = frames.length;
  const computedDurationSeconds = frameCount > 0 ? ((frameCount - 1) * frameInterval) / 1_000_000 : 0;
  const durationSeconds = nextAgents.length === 0
    ? (base.metadata.durationSeconds ?? computedDurationSeconds)
    : computedDurationSeconds;
  const nextBounds = computeBoundsFromAgents(nextAgents) ?? base.bounds;

  return {
    ...base,
    agents: nextAgents,
    frames,
    bounds: nextBounds,
    metadata: {
      ...base.metadata,
      frameCount,
      durationSeconds
    }
  };
}

function findFirstValidPoint(points: TrajectoryPoint[]): TrajectoryPoint | undefined {
  return points.find((point) => point.valid !== false);
}

const MAX_HISTORY_ENTRIES = 50;

function cloneScenarioState(scenario: WaymoScenario): WaymoScenario {
  let clone: WaymoScenario;
  if (typeof globalThis.structuredClone === 'function') {
    clone = globalThis.structuredClone(scenario);
  } else {
    clone = JSON.parse(JSON.stringify(scenario)) as WaymoScenario;
  }

  if ('raw' in clone) {
    clone.raw = undefined;
  }

  return clone;
}

function transformAgentTrajectory(
  agent: ScenarioAgent,
  anchorPoint: TrajectoryPoint,
  targetAnchorX: number,
  targetAnchorY: number,
  deltaHeadingRad: number
): ScenarioAgent {
  const cos = Math.cos(deltaHeadingRad);
  const sin = Math.sin(deltaHeadingRad);

  const updatedTrajectory = agent.trajectory.map((point) => {
    const relX = point.x - anchorPoint.x;
    const relY = point.y - anchorPoint.y;
    const rotatedX = relX * cos - relY * sin;
    const rotatedY = relX * sin + relY * cos;

    const nextX = targetAnchorX + rotatedX;
    const nextY = targetAnchorY + rotatedY;

    const nextHeading = typeof point.heading === 'number' ? point.heading + deltaHeadingRad : point.heading;

    let nextVelocityX = point.velocityX;
    let nextVelocityY = point.velocityY;
    if (typeof point.velocityX === 'number' || typeof point.velocityY === 'number') {
      const vx = point.velocityX ?? 0;
      const vy = point.velocityY ?? 0;
      nextVelocityX = vx * cos - vy * sin;
      nextVelocityY = vx * sin + vy * cos;
    }

    return {
      ...point,
      x: nextX,
      y: nextY,
      heading: nextHeading,
      velocityX: nextVelocityX,
      velocityY: nextVelocityY
    };
  });

  return {
    ...agent,
    trajectory: updatedTrajectory
  };
}

function samplesToTrajectoryPoints(samples: TrajectorySample[], frameIntervalMicros: number): TrajectoryPoint[] {
  if (samples.length === 0) {
    return [];
  }

  const sorted = [...samples].sort((a, b) => a.timestampMs - b.timestampMs);
  const normalised = sorted.map((sample, index) => {
    const clampedTime = index === 0 ? 0 : Math.max(0, sample.timestampMs - sorted[0].timestampMs);
    return {
      x: sample.x,
      y: sample.y,
      timeMs: clampedTime
    };
  });

  // Collapse duplicate timestamps keeping the latest position.
  const collapsed: typeof normalised = [];
  normalised.forEach((current) => {
    const last = collapsed[collapsed.length - 1];
    if (!last || Math.abs(last.timeMs - current.timeMs) > 0.0001) {
      collapsed.push(current);
      return;
    }
    collapsed[collapsed.length - 1] = current;
  });

  const points = collapsed;
  const totalDurationMs = points[points.length - 1]?.timeMs ?? 0;
  const frameIntervalMs = frameIntervalMicros / 1000;
  const finalFrameIndex = totalDurationMs > 0 ? Math.ceil(totalDurationMs / frameIntervalMs) : 0;

  const trajectory: TrajectoryPoint[] = [];
  let segmentIndex = 0;
  let lastFrameTimeMs = 0;

  for (let frameIndex = 0; frameIndex <= finalFrameIndex; frameIndex += 1) {
    const targetMs = frameIndex === finalFrameIndex ? totalDurationMs : Math.min(frameIndex * frameIntervalMs, totalDurationMs);

    while (segmentIndex < points.length - 2 && points[segmentIndex + 1].timeMs < targetMs) {
      segmentIndex += 1;
    }

    const current = points[segmentIndex];
    const next = points[Math.min(segmentIndex + 1, points.length - 1)];
    const spanMs = Math.max(next.timeMs - current.timeMs, 0);
    const alpha = spanMs > 0 ? Math.min(Math.max((targetMs - current.timeMs) / spanMs, 0), 1) : 0;

    const x = current.x + (next.x - current.x) * alpha;
    const y = current.y + (next.y - current.y) * alpha;

    let heading = 0;
    const headingDx = next.x - current.x;
    const headingDy = next.y - current.y;
    if (Math.abs(headingDx) > 1e-4 || Math.abs(headingDy) > 1e-4) {
      heading = Math.atan2(headingDy, headingDx);
    } else if (trajectory.length > 0) {
      heading = trajectory[trajectory.length - 1].heading ?? 0;
    }

    let velocityX = 0;
    let velocityY = 0;
    let speed = 0;
    if (trajectory.length > 0) {
      const prev = trajectory[trajectory.length - 1];
      const deltaTimeSec = Math.max((targetMs - lastFrameTimeMs) / 1000, 1e-4);
      velocityX = (x - prev.x) / deltaTimeSec;
      velocityY = (y - prev.y) / deltaTimeSec;
      speed = Math.hypot(velocityX, velocityY);
    }

    trajectory.push({
      frameIndex,
      timestampMicros: Math.round(targetMs * 1000),
      x,
      y,
      heading,
      velocityX,
      velocityY,
      speed,
      valid: true
    });

    lastFrameTimeMs = targetMs;
  }

  smoothTrajectoryHeadings(trajectory);

  return trajectory;
}

function smoothTrajectoryHeadings(points: TrajectoryPoint[]): void {
  if (points.length === 0) {
    return;
  }

  const windowRadius = 2;
  const smoothedHeadings: number[] = Array(points.length).fill(0);

  for (let index = 0; index < points.length; index += 1) {
    let sumX = 0;
    let sumY = 0;
    let count = 0;

    for (let offset = -windowRadius; offset <= windowRadius; offset += 1) {
      const neighbor = points[index + offset];
      if (!neighbor) {
        continue;
      }

      const vx = neighbor.velocityX ?? 0;
      const vy = neighbor.velocityY ?? 0;
      const magnitude = Math.hypot(vx, vy);
      if (magnitude < 1e-3) {
        continue;
      }

      sumX += vx / magnitude;
      sumY += vy / magnitude;
      count += 1;
    }

    if (count === 0) {
      const previousHeading = index > 0 ? smoothedHeadings[index - 1] : points[index].heading ?? 0;
      smoothedHeadings[index] = previousHeading;
    } else {
      smoothedHeadings[index] = Math.atan2(sumY / count, sumX / count);
    }
  }

  for (let index = 0; index < points.length; index += 1) {
    points[index].heading = smoothedHeadings[index];
  }
}

export type ScenarioSource = 'example' | 'uploaded' | 'blank';

const DEFAULT_FRAME_INTERVAL_MICROS = 100_000;

interface ScenarioHistoryState {
  undo: WaymoScenario[];
  redo: WaymoScenario[];
}

export interface ScenarioResource {
  id: string;
  name: string;
  source: ScenarioSource;
  scenario: WaymoScenario;
}

export interface EditingStoreValue {
  state: EditingState;
  setMode: (mode: EditingMode) => void;
  setTool: (tool: EditingTool) => void;
  hoverEntity: (ref?: EditingEntityRef) => void;
  selectEntity: (ref?: EditingEntityRef) => void;
  clearSelection: () => void;
  beginTrajectoryRecording: (input: { agentId: string; startedAtMs?: number }) => void;
  appendTrajectorySample: (sample: TrajectorySample) => void;
  completeTrajectoryRecording: (options?: { label?: string }) => EditingHistoryEntry | undefined;
  cancelTrajectoryRecording: () => void;
  pushHistoryEntry: (entry: EditingHistoryEntry) => void;
  undo: () => EditingHistoryEntry | undefined;
  redo: () => EditingHistoryEntry | undefined;
  canUndo: boolean;
  canRedo: boolean;
  reset: () => void;
}

interface ScenarioStoreValue {
  scenarios: ScenarioResource[];
  activeScenarioId?: string;
  activeScenario?: WaymoScenario;
  activeFrameIndex: number;
  activeFrame?: ScenarioFrame;
  isPlaying: boolean;
  playbackSpeed: number;
  visibleTrajectoryIds: ReadonlySet<string>;
  showAgentLabels: boolean;
  selectScenario: (id: string) => void;
  setActiveFrameIndex: (index: number) => void;
  play: () => void;
  pause: () => void;
  setPlaybackSpeed: (speed: number) => void;
  toggleTrajectoryVisibility: (id: string) => void;
  showAllTrajectories: () => void;
  hideAllTrajectories: () => void;
  toggleAgentLabels: () => void;
  toggleAgentExpert: (scenarioId: string, agentId: string) => boolean;
  removeAllAgents: (scenarioId: string) => boolean;
  spawnVehicleAgent: (scenarioId: string) => ScenarioAgent | undefined;
  removeScenario: (id: string) => void;
  loadScenarioFromJson: (payload: { json: unknown; name?: string; source?: ScenarioSource }) => ScenarioResource;
  createBlankScenario: (name?: string) => ScenarioResource;
  updateScenario: (id: string, updater: (current: WaymoScenario) => WaymoScenario) => void;
  updateAgentStartPose: (
    scenarioId: string,
    agentId: string,
    next: { x?: number; y?: number; headingRadians?: number }
  ) => void;
  applyRecordedTrajectory: (
    scenarioId: string,
    agentId: string,
    samples: TrajectorySample[]
  ) => boolean;
  editing: EditingStoreValue;
}

const ScenarioStoreContext = createContext<ScenarioStoreValue | undefined>(undefined);

function createResourceId(prefix = 'scenario'): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function ScenarioStoreProvider({ children }: PropsWithChildren<unknown>) {
  const [scenarios, setScenarios] = useState<ScenarioResource[]>([]);
  const [activeScenarioId, setActiveScenarioId] = useState<string | undefined>();
  const [activeFrameIndex, internalSetActiveFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeedState] = useState(1);
  const [visibleTrajectoryIds, setVisibleTrajectoryIds] = useState<Set<string>>(new Set());
  const [showAgentLabels, setShowAgentLabels] = useState(true);
  const [editingState, setEditingState] = useState<EditingState>(() => createInitialEditingState());
  const [scenarioHistory, setScenarioHistory] = useState<Record<string, ScenarioHistoryState>>({});
  const isApplyingHistoryRef = useRef(false);

  const restoreScenarioSnapshot = useCallback((scenarioId: string, snapshot: WaymoScenario) => {
    const nextScenario = cloneScenarioState(snapshot);
    isApplyingHistoryRef.current = true;
    setScenarios((prev) => prev.map((resource) => (
      resource.id === scenarioId
        ? { ...resource, scenario: nextScenario }
        : resource
    )));
    isApplyingHistoryRef.current = false;

    setVisibleTrajectoryIds(new Set(nextScenario.agents.map((agent) => agent.id)));
    internalSetActiveFrameIndex((current) => {
      const frameCount = nextScenario.frames.length;
      if (frameCount === 0) {
        return 0;
      }
      return Math.min(Math.max(current, 0), frameCount - 1);
    });
    setIsPlaying(false);
  }, [setScenarios, setVisibleTrajectoryIds, internalSetActiveFrameIndex]);

  const applyScenarioUpdate = useCallback((scenarioId: string, mutator: (scenario: WaymoScenario) => WaymoScenario | undefined | null) => {
    let previousSnapshot: WaymoScenario | undefined;
    let didUpdate = false;

    setScenarios((prev) => prev.map((resource) => {
      if (resource.id !== scenarioId) {
        return resource;
      }

      const currentScenario = resource.scenario;
      const nextScenario = mutator(currentScenario);

      if (!nextScenario || nextScenario === currentScenario) {
        return resource;
      }

      if (!isApplyingHistoryRef.current) {
        previousSnapshot = previousSnapshot ?? cloneScenarioState(currentScenario);
      }

      didUpdate = true;
      return {
        ...resource,
        scenario: nextScenario
      };
    }));

    if (previousSnapshot) {
      const snapshotCopy = previousSnapshot;
      setScenarioHistory((prev) => {
        const history = prev[scenarioId] ?? { undo: [], redo: [] };
        const undo = [...history.undo, snapshotCopy];
        if (undo.length > MAX_HISTORY_ENTRIES) {
          undo.shift();
        }
        return {
          ...prev,
          [scenarioId]: {
            undo,
            redo: []
          }
        };
      });
    }

    return didUpdate;
  }, [setScenarios, setScenarioHistory]);

  const undoScenarioState = useCallback((scenarioId: string) => {
    let snapshot: WaymoScenario | undefined;
    let didFind = false;

    setScenarioHistory((prev) => {
      const history = prev[scenarioId];
      if (!history || history.undo.length === 0) {
        return prev;
      }

      snapshot = history.undo[history.undo.length - 1];
      const undo = history.undo.slice(0, -1);
      const redo = [...history.redo];
      const currentScenarioState = scenarios.find((resource) => resource.id === scenarioId)?.scenario;
      if (currentScenarioState) {
        const currentClone = cloneScenarioState(currentScenarioState);
        redo.push(currentClone);
      }

      didFind = true;
      return {
        ...prev,
        [scenarioId]: {
          undo,
          redo
        }
      };
    });

    if (!didFind || !snapshot) {
      return false;
    }

    restoreScenarioSnapshot(scenarioId, snapshot);
    return true;
  }, [restoreScenarioSnapshot, scenarios, setScenarioHistory]);

  const redoScenarioState = useCallback((scenarioId: string) => {
    let snapshot: WaymoScenario | undefined;
    let didFind = false;

    setScenarioHistory((prev) => {
      const history = prev[scenarioId];
      if (!history || history.redo.length === 0) {
        return prev;
      }

      snapshot = history.redo[history.redo.length - 1];
      const redo = history.redo.slice(0, -1);
      const undo = [...history.undo];
      const currentScenarioState = scenarios.find((resource) => resource.id === scenarioId)?.scenario;
      if (currentScenarioState) {
        const currentClone = cloneScenarioState(currentScenarioState);
        undo.push(currentClone);
        if (undo.length > MAX_HISTORY_ENTRIES) {
          undo.shift();
        }
      }

      didFind = true;
      return {
        ...prev,
        [scenarioId]: {
          undo,
          redo
        }
      };
    });

    if (!didFind || !snapshot) {
      return false;
    }

    restoreScenarioSnapshot(scenarioId, snapshot);
    return true;
  }, [restoreScenarioSnapshot, scenarios, setScenarioHistory]);

  const selectScenario = useCallback((id: string) => {
    setActiveScenarioId(id);
  }, []);

  const upsertScenario = useCallback((resource: ScenarioResource) => {
    setScenarios((prev) => {
      const existingIndex = prev.findIndex((item) => item.id === resource.id);
      if (existingIndex === -1) {
        return [...prev, resource];
      }

      const next = [...prev];
      next.splice(existingIndex, 1, resource);
      return next;
    });
  }, []);

  const loadScenarioFromJson = useCallback<ScenarioStoreValue['loadScenarioFromJson']>(({ json, name, source = 'uploaded' }) => {
    const parsed = parseScenario(json);

    const resource: ScenarioResource = {
      id: parsed.metadata.id || createResourceId('scenario'),
      name: name || parsed.metadata.name || 'Imported Scenario',
      source,
      scenario: parsed
    };

    upsertScenario(resource);
    setActiveScenarioId(resource.id);
    internalSetActiveFrameIndex(0);
    setVisibleTrajectoryIds(new Set(parsed.agents.map((agent) => agent.id)));
    setIsPlaying(false);
    setShowAgentLabels(true);
    setScenarioHistory((prev) => ({
      ...prev,
      [resource.id]: {
        undo: [],
        redo: []
      }
    }));

    return resource;
  }, [upsertScenario]);

  const createBlankScenario = useCallback<ScenarioStoreValue['createBlankScenario']>((name) => {
    const scenario: WaymoScenario = {
      metadata: {
        id: createResourceId('blank'),
        name: name || 'Blank Scenario',
        frameCount: 0,
        durationSeconds: 0,
        frameIntervalMicros: undefined
      },
      agents: [],
      roadEdges: [],
      frames: [],
      bounds: undefined,
      raw: undefined
    };

    const resource: ScenarioResource = {
      id: scenario.metadata.id,
      name: scenario.metadata.name,
      source: 'blank',
      scenario
    };

    upsertScenario(resource);
    setActiveScenarioId(resource.id);
    internalSetActiveFrameIndex(0);
    setVisibleTrajectoryIds(new Set(scenario.agents.map((agent) => agent.id)));
    setIsPlaying(false);
    setShowAgentLabels(true);
    setScenarioHistory((prev) => ({
      ...prev,
      [resource.id]: {
        undo: [],
        redo: []
      }
    }));

    return resource;
  }, [upsertScenario]);

  const updateScenario = useCallback<ScenarioStoreValue['updateScenario']>((id, updater) => {
    applyScenarioUpdate(id, (scenario) => updater(scenario));
  }, [applyScenarioUpdate]);

  const removeScenario = useCallback<ScenarioStoreValue['removeScenario']>((id) => {
    setScenarios((prev) => prev.filter((resource) => resource.id !== id));
    setActiveScenarioId((current) => (current === id ? undefined : current));
    setVisibleTrajectoryIds(new Set());
    setIsPlaying(false);
    setShowAgentLabels(false);
    setScenarioHistory((prev) => {
      if (!(id in prev)) {
        return prev;
      }
      const { [id]: _removed, ...rest } = prev;
      return rest;
    });
  }, []);

  const activeScenario = useMemo(() => scenarios.find((resource) => resource.id === activeScenarioId)?.scenario, [scenarios, activeScenarioId]);
  const activeScenarioHistory = scenarioHistory[activeScenarioId ?? ''];
  const canUndo = (activeScenarioHistory?.undo.length ?? 0) > 0 && editingState.history.undoStack.length > 0;
  const canRedo = (activeScenarioHistory?.redo.length ?? 0) > 0 && editingState.history.redoStack.length > 0;

  useEffect(() => {
    internalSetActiveFrameIndex(0);
    setVisibleTrajectoryIds((prev) => {
      if (!activeScenario) {
        return new Set();
      }

      if (prev.size === activeScenario.agents.length) {
        return prev;
      }

      return new Set(activeScenario.agents.map((agent) => agent.id));
    });
    setIsPlaying(false);
    setShowAgentLabels(Boolean(activeScenario));
  }, [activeScenarioId, activeScenario]);

  useEffect(() => {
    const frameCount = activeScenario?.frames.length ?? 0;
    internalSetActiveFrameIndex((current) => {
      if (frameCount === 0) {
        return 0;
      }
      return Math.min(Math.max(current, 0), frameCount - 1);
    });
  }, [activeScenario?.frames.length]);

  const setActiveFrameIndex = useCallback<ScenarioStoreValue['setActiveFrameIndex']>((index) => {
    internalSetActiveFrameIndex(() => {
      const frameCount = activeScenario?.frames.length ?? 0;
      if (frameCount === 0) {
        return 0;
      }
      return Math.min(Math.max(index, 0), frameCount - 1);
    });
  }, [activeScenario?.frames.length]);

  const activeFrame = useMemo(() => {
    if (!activeScenario) {
      return undefined;
    }

    return activeScenario.frames[activeFrameIndex];
  }, [activeScenario, activeFrameIndex]);

  useEffect(() => {
    if (!isPlaying || !activeScenario) {
      return undefined;
    }

    const frameIntervalMicros = activeScenario.metadata.frameIntervalMicros ?? DEFAULT_FRAME_INTERVAL_MICROS;
    const baseIntervalMs = frameIntervalMicros / 1000;
    const intervalMs = Math.max(baseIntervalMs / playbackSpeed, 16);

    const timer = window.setInterval(() => {
      internalSetActiveFrameIndex((current) => {
        const frameCount = activeScenario.frames.length;
        if (frameCount === 0) {
          return 0;
        }

        const next = current + 1;
        if (next >= frameCount) {
          setIsPlaying(false);
          return frameCount - 1;
        }

        return next;
      });
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [isPlaying, playbackSpeed, activeScenario]);

  const play = useCallback(() => {
    if (!activeScenario || activeScenario.frames.length === 0) {
      return;
    }

    internalSetActiveFrameIndex((current) => {
      const frameCount = activeScenario.frames.length;
      if (frameCount === 0) {
        return current;
      }

      if (current >= frameCount - 1) {
        return 0;
      }

      return current;
    });

    setIsPlaying(true);
  }, [activeScenario]);

  const pause = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const handleSetPlaybackSpeed = useCallback((speed: number) => {
    setPlaybackSpeedState(Math.max(speed, 0.1));
  }, []);

  const toggleTrajectoryVisibility = useCallback<ScenarioStoreValue['toggleTrajectoryVisibility']>((id) => {
    setVisibleTrajectoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const showAllTrajectories = useCallback(() => {
    if (!activeScenario) {
      setVisibleTrajectoryIds(new Set());
      return;
    }
    setVisibleTrajectoryIds(new Set(activeScenario.agents.map((agent) => agent.id)));
  }, [activeScenario]);

  const hideAllTrajectories = useCallback(() => {
    setVisibleTrajectoryIds(new Set());
  }, []);

  const toggleAgentLabels = useCallback(() => {
    setShowAgentLabels((prev) => !prev);
  }, []);

  const toggleAgentExpert = useCallback<ScenarioStoreValue['toggleAgentExpert']>((scenarioId, agentId) => {
    let didUpdate = false;

    applyScenarioUpdate(scenarioId, (scenario) => {
      const targetIndex = scenario.agents.findIndex((agent) => agent.id === agentId);
      if (targetIndex === -1) {
        return scenario;
      }

      didUpdate = true;

      const nextAgents = scenario.agents.map((agent, index) => (
        index === targetIndex
          ? { ...agent, isExpert: !agent.isExpert }
          : agent
      ));

      return {
        ...scenario,
        agents: nextAgents
      };
    });

    return didUpdate;
  }, [applyScenarioUpdate]);

  const removeAllAgents = useCallback<ScenarioStoreValue['removeAllAgents']>((scenarioId) => {
    let didRemove = false;

    applyScenarioUpdate(scenarioId, (scenario) => {
      if (scenario.agents.length === 0) {
        return scenario;
      }

      didRemove = true;
      return withScenarioRebuild(scenario, []);
    });

    if (didRemove && activeScenarioId === scenarioId) {
      setVisibleTrajectoryIds(new Set());
    }

    return didRemove;
  }, [activeScenarioId, applyScenarioUpdate, setVisibleTrajectoryIds]);

  const spawnVehicleAgent = useCallback<ScenarioStoreValue['spawnVehicleAgent']>((scenarioId) => {
    let createdAgent: ScenarioAgent | undefined;

    applyScenarioUpdate(scenarioId, (scenario) => {
      const existingAgents = scenario.agents;
      const bounds = scenario.bounds ?? computeBoundsFromAgents(existingAgents) ?? {
        minX: -20,
        maxX: 20,
        minY: -20,
        maxY: 20
      };
      const centerX = (bounds.minX + bounds.maxX) / 2;
      const centerY = (bounds.minY + bounds.maxY) / 2;
      const spanX = bounds.maxX - bounds.minX;
      const spanY = bounds.maxY - bounds.minY;
      const radius = Math.max(Math.hypot(spanX, spanY) / 8, 6);
      const angle = (existingAgents.length * Math.PI) / 4;
      const spawnX = centerX + Math.cos(angle) * radius;
      const spawnY = centerY + Math.sin(angle) * radius;
      const frameInterval = scenario.metadata.frameIntervalMicros ?? DEFAULT_FRAME_INTERVAL_MICROS;

      let trajectory: TrajectoryPoint[];
      if (scenario.frames.length > 0) {
        trajectory = scenario.frames.map((frame) => ({
          frameIndex: frame.index,
          timestampMicros: frame.timestampMicros,
          x: spawnX,
          y: spawnY,
          heading: 0,
          velocityX: 0,
          velocityY: 0,
          speed: 0,
          valid: true
        }));
      } else {
        const frameCount = scenario.metadata.frameCount > 0 ? scenario.metadata.frameCount : 60;
        trajectory = Array.from({ length: frameCount }, (_, index) => ({
          frameIndex: index,
          timestampMicros: index * frameInterval,
          x: spawnX,
          y: spawnY,
          heading: 0,
          velocityX: 0,
          velocityY: 0,
          speed: 0,
          valid: true
        }));
      }

      const nextAgent: ScenarioAgent = {
        id: createResourceId('agent'),
        type: 'VEHICLE',
        displayName: `Vehicle ${existingAgents.length + 1}`,
        dimensions: { length: 4.5, width: 2.0, height: 1.6 },
        trajectory
      };

      createdAgent = nextAgent;

      const nextAgents = [...existingAgents, nextAgent];
      return withScenarioRebuild(scenario, nextAgents);
    });

    if (createdAgent && activeScenarioId === scenarioId) {
      setVisibleTrajectoryIds((prev) => {
        const next = new Set(prev);
        next.add(createdAgent!.id);
        return next;
      });
    }

    return createdAgent;
  }, [activeScenarioId, applyScenarioUpdate, setVisibleTrajectoryIds]);

  const resetEditing = useCallback(() => {
    setEditingState(() => createInitialEditingState());
  }, []);

  const setEditingMode = useCallback((mode: EditingMode) => {
    setEditingState((prev) => ({
      ...prev,
      mode
    }));
  }, []);

  const setEditingTool = useCallback((tool: EditingTool) => {
    setEditingState((prev) => ({
      ...prev,
      activeTool: tool
    }));
  }, []);

  const hoverEntity = useCallback((ref?: EditingEntityRef) => {
    setEditingState((prev) => ({
      ...prev,
      hoveredEntity: ref
    }));
  }, []);

  const selectEntity = useCallback((ref?: EditingEntityRef) => {
    setEditingState((prev) => ({
      ...prev,
      selectedEntity: ref
    }));
  }, []);

  const clearSelection = useCallback(() => {
    setEditingState((prev) => ({
      ...prev,
      selectedEntity: undefined
    }));
  }, []);

  const beginTrajectoryRecording = useCallback((input: { agentId: string; startedAtMs?: number }) => {
    const now = input.startedAtMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    setEditingState((prev) => ({
      ...prev,
      mode: 'trajectory',
      activeTool: 'trajectory-record',
      selectedEntity: { kind: 'agent', id: input.agentId },
      isRecording: true,
      trajectoryDraft: {
        agentId: input.agentId,
        startedAtMs: now,
        lastSampledAtMs: now,
        samples: []
      }
    }));
  }, []);

  const appendTrajectorySample = useCallback((sample: TrajectorySample) => {
    setEditingState((prev) => {
      if (!prev.isRecording || !prev.trajectoryDraft) {
        return prev;
      }

      return {
        ...prev,
        trajectoryDraft: {
          ...prev.trajectoryDraft,
          lastSampledAtMs: sample.timestampMs,
          samples: [...prev.trajectoryDraft.samples, sample]
        }
      };
    });
  }, []);

  const completeTrajectoryRecording = useCallback((options?: { label?: string }) => {
    let createdEntry: EditingHistoryEntry | undefined;
    setEditingState((prev) => {
      if (!prev.isRecording || !prev.trajectoryDraft) {
        return prev;
      }

      const label = options?.label?.trim();
      if (label) {
        createdEntry = {
          id: createResourceId('edit'),
          label,
          timestamp: Date.now()
        };
      }

      return {
        ...prev,
        activeTool: prev.activeTool === 'trajectory-record' || prev.activeTool === 'trajectory-drive'
          ? 'trajectory-edit'
          : prev.activeTool,
        isRecording: false,
        trajectoryDraft: undefined,
        history: createdEntry
          ? {
              undoStack: [...prev.history.undoStack, createdEntry],
              redoStack: []
            }
          : prev.history
      };
    });

    return createdEntry;
  }, []);

  const cancelTrajectoryRecording = useCallback(() => {
    setEditingState((prev) => ({
      ...prev,
      isRecording: false,
      trajectoryDraft: undefined,
      activeTool: prev.activeTool === 'trajectory-record'
        ? 'select'
        : prev.activeTool === 'trajectory-drive'
          ? 'trajectory-edit'
          : prev.activeTool
    }));
  }, []);

  const pushHistoryEntry = useCallback((entry: EditingHistoryEntry) => {
    setEditingState((prev) => ({
      ...prev,
      history: {
        undoStack: [...prev.history.undoStack, entry],
        redoStack: []
      }
    }));
  }, []);

  const undo = useCallback(() => {
    if (!activeScenarioId) {
      return undefined;
    }

    const reverted = undoScenarioState(activeScenarioId);
    if (!reverted) {
      return undefined;
    }

    let entry: EditingHistoryEntry | undefined;
    setEditingState((prev) => {
      if (prev.history.undoStack.length === 0) {
        return prev;
      }

      entry = prev.history.undoStack[prev.history.undoStack.length - 1];

      return {
        ...prev,
        history: {
          undoStack: prev.history.undoStack.slice(0, -1),
          redoStack: entry ? [entry, ...prev.history.redoStack] : prev.history.redoStack
        }
      };
    });

    return entry;
  }, [activeScenarioId, undoScenarioState]);

  const redo = useCallback(() => {
    if (!activeScenarioId) {
      return undefined;
    }

    const reapplied = redoScenarioState(activeScenarioId);
    if (!reapplied) {
      return undefined;
    }

    let entry: EditingHistoryEntry | undefined;
    setEditingState((prev) => {
      if (prev.history.redoStack.length === 0) {
        return prev;
      }

      entry = prev.history.redoStack[0];

      return {
        ...prev,
        history: {
          undoStack: entry ? [...prev.history.undoStack, entry] : prev.history.undoStack,
          redoStack: prev.history.redoStack.slice(1)
        }
      };
    });

    return entry;
  }, [activeScenarioId, redoScenarioState]);

  const updateAgentStartPose = useCallback<ScenarioStoreValue['updateAgentStartPose']>((scenarioId, agentId, next) => {
    applyScenarioUpdate(scenarioId, (scenario) => {
      const agent = scenario.agents.find((item) => item.id === agentId);
      if (!agent) {
        return scenario;
      }

      const anchorPoint = findFirstValidPoint(agent.trajectory) ?? agent.trajectory[0];
      if (!anchorPoint) {
        return scenario;
      }

      const targetX = next.x ?? anchorPoint.x;
      const targetY = next.y ?? anchorPoint.y;
      const targetHeading = next.headingRadians ?? anchorPoint.heading ?? 0;
      const deltaHeading = targetHeading - (anchorPoint.heading ?? 0);

      const updatedAgent = transformAgentTrajectory(agent, anchorPoint, targetX, targetY, deltaHeading);
      const nextAgents = scenario.agents.map((item) => (item.id === agentId ? updatedAgent : item));
      return withScenarioRebuild(scenario, nextAgents);
    });
  }, [applyScenarioUpdate]);

  const applyRecordedTrajectory = useCallback<ScenarioStoreValue['applyRecordedTrajectory']>((scenarioId, agentId, samples) => {
    if (samples.length === 0) {
      return false;
    }

    let didUpdate = false;

    applyScenarioUpdate(scenarioId, (scenario) => {
      const agentIndex = scenario.agents.findIndex((agent) => agent.id === agentId);
      if (agentIndex === -1) {
        return scenario;
      }

      const frameInterval = scenario.metadata.frameIntervalMicros ?? DEFAULT_FRAME_INTERVAL_MICROS;
      const trajectory = samplesToTrajectoryPoints(samples, frameInterval);
      if (trajectory.length === 0) {
        return scenario;
      }

      didUpdate = true;

      const nextAgents = scenario.agents.map((agent) => (
        agent.id === agentId
          ? { ...agent, trajectory }
          : agent
      ));

      return withScenarioRebuild(scenario, nextAgents);
    });

    return didUpdate;
  }, [applyScenarioUpdate]);

  useEffect(() => {
    resetEditing();
  }, [activeScenarioId, resetEditing]);

  const editingValue = useMemo<EditingStoreValue>(() => ({
    state: editingState,
    setMode: setEditingMode,
    setTool: setEditingTool,
    hoverEntity,
    selectEntity,
    clearSelection,
    beginTrajectoryRecording,
    appendTrajectorySample,
    completeTrajectoryRecording,
    cancelTrajectoryRecording,
    pushHistoryEntry,
    undo,
    redo,
    canUndo,
    canRedo,
    reset: resetEditing
  }), [
    editingState,
    setEditingMode,
    setEditingTool,
    hoverEntity,
    selectEntity,
    clearSelection,
    beginTrajectoryRecording,
    appendTrajectorySample,
    completeTrajectoryRecording,
    cancelTrajectoryRecording,
    pushHistoryEntry,
    undo,
    redo,
    canUndo,
    canRedo,
    resetEditing
  ]);

  const value = useMemo<ScenarioStoreValue>(() => ({
    scenarios,
    activeScenarioId,
    activeScenario,
    activeFrameIndex,
    activeFrame,
    isPlaying,
    playbackSpeed,
    visibleTrajectoryIds,
    showAgentLabels,
    selectScenario,
    setActiveFrameIndex,
    play,
    pause,
    setPlaybackSpeed: handleSetPlaybackSpeed,
    toggleTrajectoryVisibility,
    showAllTrajectories,
    hideAllTrajectories,
    toggleAgentLabels,
    toggleAgentExpert,
    removeAllAgents,
    spawnVehicleAgent,
    removeScenario,
    loadScenarioFromJson,
    createBlankScenario,
    updateScenario,
    updateAgentStartPose,
    applyRecordedTrajectory,
    editing: editingValue
  }), [
    scenarios,
    activeScenarioId,
    activeScenario,
    activeFrameIndex,
    activeFrame,
    isPlaying,
    playbackSpeed,
    visibleTrajectoryIds,
    showAgentLabels,
    selectScenario,
    setActiveFrameIndex,
    play,
    pause,
    handleSetPlaybackSpeed,
    toggleTrajectoryVisibility,
    showAllTrajectories,
    hideAllTrajectories,
    toggleAgentLabels,
    toggleAgentExpert,
    removeAllAgents,
    spawnVehicleAgent,
    removeScenario,
    loadScenarioFromJson,
    createBlankScenario,
    updateScenario,
    updateAgentStartPose,
    applyRecordedTrajectory,
    editingValue
  ]);

  return <ScenarioStoreContext.Provider value={value}>{children}</ScenarioStoreContext.Provider>;
}

export function useScenarioStore() {
  const context = useContext(ScenarioStoreContext);
  if (!context) {
    throw new Error('useScenarioStore must be used within ScenarioStoreProvider');
  }

  return context;
}
