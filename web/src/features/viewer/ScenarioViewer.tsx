import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  useScenarioStore,
  type EditingEntityRef,
  type EditingMode,
  type EditingTool
} from '@/state/scenarioStore';
import { RoadEdge, ScenarioAgent, ScenarioBounds, ScenarioFrameAgentState } from '@/types/scenario';

type CameraState = {
  zoom: number;
  panX: number;
  panY: number;
  rotation: number;
};

interface CanvasTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
  height: number;
}

interface CanvasDims {
  width: number;
  height: number;
}

type TrajectoryDrawOptions = {
  highlight?: 'selected' | 'hovered';
};

type AgentHighlightState = {
  selected?: boolean;
  hovered?: boolean;
};

interface BaseTransformContext {
  transform: CanvasTransform;
  width: number;
  height: number;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const DEFAULT_FRAME_INTERVAL_MICROS = 100_000;

const DRIVE_CONFIG = {
  maxSpeed: 14, // ~50 km/h
  maxReverseSpeed: 4,
  acceleration: 6,
  reverseAcceleration: 3,
  brakeDeceleration: 10,
  drag: 1.8,
  steerRate: 2.4 // radians per second at full speed
};

interface DriveSession {
  agentId: string;
  startTimestampMs: number;
  lastTimestampMs: number;
  nextSampleTimestampMs: number;
  position: { x: number; y: number };
  heading: number;
  speed: number;
}

interface DriveControlsState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  brake: boolean;
}

type DriveModeStopper = (commit: boolean) => void;

const TYPE_COLOURS: Record<string, string> = {
  VEHICLE: '#38bdf8',
  PEDESTRIAN: '#f97316',
  CYCLIST: '#facc15',
  OTHER: '#e2e8f0'
};

const VEHICLE_COLOURS = {
  expert: '#facc15',
  nonExpert: '#38bdf8'
};

const INACTIVE_AGENT_COLOUR = {
  fill: 'rgba(148, 163, 184, 0.55)',
  stroke: 'rgba(100, 116, 139, 0.8)'
};

const DEFAULT_AGENT_DIMENSIONS: Record<string, { length: number; width: number; height?: number }> = {
  VEHICLE: { length: 4.5, width: 2.0, height: 1.6 },
  PEDESTRIAN: { length: 0.8, width: 0.8, height: 1.8 },
  CYCLIST: { length: 1.8, width: 0.6, height: 1.6 },
  OTHER: { length: 2.0, width: 1.0, height: 1.5 }
};

const ROAD_STYLES: Record<string, { stroke: string; width: number; dash?: number[] }> = {
  ROAD_LINE: { stroke: 'rgba(148, 163, 184, 0.65)', width: 1.5, dash: [6, 8] },
  ROAD_EDGE: { stroke: 'rgba(203, 213, 225, 0.9)', width: 2.2 },
  CROSSWALK: { stroke: 'rgba(248, 113, 113, 0.5)', width: 1.2, dash: [4, 6] },
  OTHER: { stroke: 'rgba(148, 163, 184, 0.35)', width: 1.0 }
};

function computeTransform(bounds: ScenarioBounds | undefined, width = 1, height = 1): CanvasTransform {
  const padding = 40;
  const spanX = bounds ? bounds.maxX - bounds.minX : 100;
  const spanY = bounds ? bounds.maxY - bounds.minY : 100;

  const safeSpanX = spanX === 0 ? 1 : spanX;
  const safeSpanY = spanY === 0 ? 1 : spanY;

  const scaleX = (width - padding * 2) / safeSpanX;
  const scaleY = (height - padding * 2) / safeSpanY;
  const scale = Math.max(Math.min(scaleX, scaleY), 0.0001);

  const offsetX = bounds ? bounds.minX : -safeSpanX / 2;
  const offsetY = bounds ? bounds.minY : -safeSpanY / 2;

  return { scale, offsetX, offsetY, height };
}

function worldToAnchor(point: { x: number; y: number }, base: CanvasTransform, dims: CanvasDims) {
  const anchorX = (point.x - base.offsetX) * base.scale;
  const anchorY = dims.height - (point.y - base.offsetY) * base.scale;
  return { x: anchorX, y: anchorY };
}

function worldToCanvas(
  point: { x: number; y: number },
  base: CanvasTransform,
  camera: CameraState,
  dims: CanvasDims
) {
  const { width, height } = dims;
  const anchor = worldToAnchor(point, base, dims);
  const centerX = width / 2;
  const centerY = height / 2;

  const dx = anchor.x - centerX;
  const dy = anchor.y - centerY;
  const cos = Math.cos(camera.rotation);
  const sin = Math.sin(camera.rotation);
  const rotatedX = dx * cos - dy * sin;
  const rotatedY = dx * sin + dy * cos;

  const zoomedX = rotatedX * camera.zoom + centerX + camera.panX;
  const zoomedY = rotatedY * camera.zoom + centerY + camera.panY;

  return { x: zoomedX, y: zoomedY };
}

function canvasToWorld(
  canvasX: number,
  canvasY: number,
  base: CanvasTransform,
  camera: CameraState,
  dims: CanvasDims
) {
  const { width, height } = dims;
  const centerX = width / 2;
  const centerY = height / 2;

  const dx = (canvasX - centerX - camera.panX) / camera.zoom;
  const dy = (canvasY - centerY - camera.panY) / camera.zoom;
  const cos = Math.cos(camera.rotation);
  const sin = Math.sin(camera.rotation);
  const rotatedX = dx * cos + dy * sin;
  const rotatedY = -dx * sin + dy * cos;

  const anchorX = rotatedX + centerX;
  const anchorY = rotatedY + centerY;

  const worldX = anchorX / base.scale + base.offsetX;
  const worldY = base.offsetY + (height - anchorY) / base.scale;

  return { x: worldX, y: worldY };
}

function drawRoadEdges(
  ctx: CanvasRenderingContext2D,
  edges: RoadEdge[],
  base: CanvasTransform,
  camera: CameraState,
  dims: CanvasDims
) {
  ctx.save();

  edges.forEach((edge) => {
    if (!edge.points || edge.points.length < 2) {
      return;
    }

    const style = edge.type ? ROAD_STYLES[edge.type] ?? ROAD_STYLES.OTHER : ROAD_STYLES.OTHER;
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.width;
    ctx.setLineDash(style.dash ?? []);

    const first = worldToCanvas(edge.points[0], base, camera, dims);
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < edge.points.length; i += 1) {
      const { x, y } = worldToCanvas(edge.points[i], base, camera, dims);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  });

  ctx.restore();
}

function getTrajectoryColour(agent: ScenarioAgent) {
  if (agent.type === 'VEHICLE') {
    return agent.isExpert ? 'rgba(34, 197, 94, 0.6)' : 'rgba(56, 189, 248, 0.65)';
  }

  return {
    PEDESTRIAN: 'rgba(249, 115, 22, 0.5)',
    CYCLIST: 'rgba(250, 204, 21, 0.5)',
    OTHER: 'rgba(226, 232, 240, 0.35)'
  }[agent.type] ?? 'rgba(226, 232, 240, 0.35)';
}

function drawTrajectory(
  ctx: CanvasRenderingContext2D,
  agent: ScenarioAgent,
  base: CanvasTransform,
  camera: CameraState,
  dims: CanvasDims,
  options: TrajectoryDrawOptions = {}
) {
  if (!agent.trajectory.length) {
    return;
  }

  ctx.save();
  const highlight = options.highlight;
  const baseColour = getTrajectoryColour(agent);
  ctx.strokeStyle = highlight === 'selected'
    ? 'rgba(250, 204, 21, 0.95)'
    : highlight === 'hovered'
      ? 'rgba(34, 211, 238, 0.9)'
      : baseColour;
  ctx.lineWidth = highlight === 'selected'
    ? 3.4
    : highlight === 'hovered'
      ? 2.8
      : 2.25;
  ctx.setLineDash(highlight === 'hovered' ? [10, 12] : []);

  let hasStarted = false;
  let lastPoint: { x: number; y: number } | null = null;

  agent.trajectory.forEach((point) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      hasStarted = false;
      lastPoint = null;
      return;
    }

    if (point.valid === false) {
      if (hasStarted) {
        ctx.stroke();
      }
      hasStarted = false;
      lastPoint = null;
      return;
    }

    if (Math.abs(point.x) > 1e4 || Math.abs(point.y) > 1e4) {
      if (hasStarted) {
        ctx.stroke();
      }
      hasStarted = false;
      lastPoint = null;
      return;
    }

    if (lastPoint) {
      const dx = point.x - lastPoint.x;
      const dy = point.y - lastPoint.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 150) {
        if (hasStarted) {
          ctx.stroke();
        }
        hasStarted = false;
        lastPoint = null;
      }
    }

    const { x, y } = worldToCanvas(point, base, camera, dims);

    if (!hasStarted) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      hasStarted = true;
    } else {
      ctx.lineTo(x, y);
    }

    lastPoint = { x: point.x, y: point.y };
  });

  if (hasStarted) {
    ctx.stroke();
  }

  ctx.restore();
}

function getAgentColours(agentState: ScenarioFrameAgentState, agentInfo?: ScenarioAgent) {
  if (agentState.valid === false) {
    return INACTIVE_AGENT_COLOUR;
  }

  if (agentState.type === 'VEHICLE') {
    const fill = agentInfo?.isExpert ? VEHICLE_COLOURS.expert : VEHICLE_COLOURS.nonExpert;
    return {
      fill,
      stroke: agentInfo?.isExpert ? '#a16207' : '#0f172a'
    };
  }

  const fill = TYPE_COLOURS[agentState.type] ?? TYPE_COLOURS.OTHER;
  return {
    fill,
    stroke: '#0f172a'
  };
}

function resolveAgentDimensions(agentState: ScenarioFrameAgentState, agentInfo?: ScenarioAgent) {
  const fallbackDims = DEFAULT_AGENT_DIMENSIONS[agentState.type] ?? DEFAULT_AGENT_DIMENSIONS.OTHER;
  const dimensions = agentInfo?.dimensions ?? fallbackDims;

  return {
    length: agentState.length ?? dimensions.length ?? fallbackDims.length,
    width: agentState.width ?? dimensions.width ?? fallbackDims.width,
    height: agentState.height ?? dimensions.height
  };
}

function isPointInsideAgent(
  point: { x: number; y: number },
  agentState: ScenarioFrameAgentState,
  agentInfo?: ScenarioAgent
) {
  const { length, width } = resolveAgentDimensions(agentState, agentInfo);
  if (length <= 0 || width <= 0) {
    return false;
  }

  const heading = agentState.heading ?? 0;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const dx = point.x - agentState.x;
  const dy = point.y - agentState.y;

  const localX = cos * dx + sin * dy;
  const localY = -sin * dx + cos * dy;

  return Math.abs(localX) <= length / 2 && Math.abs(localY) <= width / 2;
}

function distanceToSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number }
) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
  const projX = start.x + t * dx;
  const projY = start.y + t * dy;
  return Math.hypot(point.x - projX, point.y - projY);
}

function distanceToTrajectory(point: { x: number; y: number }, agent: ScenarioAgent) {
  let best = Number.POSITIVE_INFINITY;

  for (let i = 1; i < agent.trajectory.length; i += 1) {
    const prev = agent.trajectory[i - 1];
    const current = agent.trajectory[i];

    if (prev.valid === false || current.valid === false) {
      continue;
    }

    const segmentDistance = distanceToSegment(point, prev, current);
    if (segmentDistance < best) {
      best = segmentDistance;
    }
  }

  return best;
}

function drawAgent(
  ctx: CanvasRenderingContext2D,
  agentState: ScenarioFrameAgentState,
  base: CanvasTransform,
  camera: CameraState,
  dims: CanvasDims,
  agentInfo?: ScenarioAgent,
  showLabel?: boolean,
  highlight?: AgentHighlightState
) {
  const dimensions = resolveAgentDimensions(agentState, agentInfo);
  const lengthMeters = dimensions.length;
  const widthMeters = dimensions.width;

  const lengthPx = lengthMeters * base.scale * camera.zoom;
  const widthPx = widthMeters * base.scale * camera.zoom;

  const { x, y } = worldToCanvas({ x: agentState.x, y: agentState.y }, base, camera, dims);

  const colours = getAgentColours(agentState, agentInfo);
  const labelText = showLabel ? agentInfo?.displayName ?? agentState.id : undefined;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-(agentState.heading ?? 0));
  ctx.fillStyle = colours.fill;
  ctx.strokeStyle = colours.stroke;
  ctx.lineWidth = 1.5;

  const halfLength = lengthPx / 2;
  const halfWidth = widthPx / 2;

  ctx.beginPath();
  ctx.rect(-halfLength, -halfWidth, lengthPx, widthPx);
  ctx.fill();
  ctx.stroke();

  if (agentState.valid !== false) {
    ctx.beginPath();
    ctx.moveTo(halfLength * 0.2, 0);
    ctx.lineTo(halfLength * 0.6, 0);
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.65)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  if (highlight?.selected || highlight?.hovered) {
    const isSelected = Boolean(highlight?.selected);
    ctx.lineWidth = Math.max(isSelected ? 3.2 : 2.2, (isSelected ? 3.2 : 2.2) / camera.zoom);
    ctx.strokeStyle = isSelected ? 'rgba(250, 204, 21, 0.92)' : 'rgba(94, 234, 212, 0.9)';
    ctx.setLineDash(isSelected ? [] : [12 / camera.zoom, 12 / camera.zoom]);
    ctx.strokeRect(-halfLength, -halfWidth, lengthPx, widthPx);
  }

  ctx.restore();

  if (labelText) {
    const fontSize = Math.max(9, 11 / camera.zoom);
    const verticalGap = Math.max(6, 10 / camera.zoom);
    const anchorY = y - halfWidth - verticalGap;

    ctx.save();
    ctx.font = `${fontSize}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const metrics = ctx.measureText(labelText);
    const paddingX = 4;
    const paddingY = 2;
    const rectWidth = metrics.width + paddingX * 2;
    const rectHeight = fontSize + paddingY * 2;
    const rectX = x - rectWidth / 2;
    const rectY = anchorY - rectHeight;
    const textY = rectY + rectHeight / 2;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
    ctx.fillRect(rectX, rectY, rectWidth, rectHeight);

    ctx.fillStyle = '#f8fafc';
    ctx.fillText(labelText, x, textY);
    ctx.restore();
  }
}

function ScenarioViewer() {
  const {
    activeScenario,
    activeScenarioId,
    activeFrame,
    activeFrameIndex,
    visibleTrajectoryIds,
    showAgentLabels,
    pause,
    setActiveFrameIndex,
    applyRecordedTrajectory,
    editing
  } = useScenarioStore();
  const {
    state: editingState,
    setMode: setEditingMode,
    setTool: setEditingTool,
    hoverEntity,
    selectEntity,
    clearSelection,
    cancelTrajectoryRecording,
    beginTrajectoryRecording,
    appendTrajectorySample,
    completeTrajectoryRecording
  } = editing;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseTransformRef = useRef<BaseTransformContext | null>(null);
  const dragStateRef = useRef<{
    active: boolean;
    pointerId: number | null;
    lastX: number;
    lastY: number;
    hasMoved: boolean;
    mode: 'pan' | 'record';
  }>({
    active: false,
    pointerId: null,
    lastX: 0,
    lastY: 0,
    hasMoved: false,
    mode: 'pan'
  });

  const [camera, setCamera] = useState<CameraState>({ zoom: 1, panX: 0, panY: 0, rotation: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isDriveActive, setIsDriveActive] = useState(false);
  const driveSessionRef = useRef<DriveSession | null>(null);
  const driveAnimationRef = useRef<number | null>(null);
  const driveControlsRef = useRef<DriveControlsState>({
    forward: false,
    backward: false,
    left: false,
    right: false,
    brake: false
  });
  const stopDriveModeRef = useRef<DriveModeStopper | null>(null);
  const editingMode = editingState.mode;
  const activeTool = editingState.activeTool;
  const isRecording = editingState.isRecording;
  const selectedAgentId = editingState.selectedEntity?.kind === 'agent' ? editingState.selectedEntity.id : undefined;
  const hoveredAgentId = editingState.hoveredEntity?.kind === 'agent' ? editingState.hoveredEntity.id : undefined;
  const isEditMode = editingState.mode !== 'inspect';
  const isTrajectoryMode = editingMode === 'trajectory';
  const isRoadMode = editingMode === 'road';
  const isPointerRecordTool = activeTool === 'trajectory-record';
  const isDriveToolSelected = activeTool === 'trajectory-drive';
  const isPointerRecordActive = isPointerRecordTool && !isDriveActive;
  const isPointerRecording = isRecording && !isDriveActive;

  const summary = useMemo(() => {
    if (!activeScenario) {
      return null;
    }

    const agentCount = activeScenario.agents.length;
    const roadEdgeCount = activeScenario.roadEdges.length;

    return {
      agentCount,
      roadEdgeCount,
      frameCount: activeScenario.metadata.frameCount,
      durationSeconds: activeScenario.metadata.durationSeconds
    };
  }, [activeScenario]);

  const agentById = useMemo(() => {
    if (!activeScenario) {
      return new Map<string, ScenarioAgent>();
    }

    return new Map(activeScenario.agents.map((agent) => [agent.id, agent]));
  }, [activeScenario]);

  const trajectoryAgents = useMemo(() => {
    if (!activeScenario) {
      return [] as ScenarioAgent[];
    }

    const ids = new Set(visibleTrajectoryIds);
    if (selectedAgentId) {
      ids.add(selectedAgentId);
    }
    if (hoveredAgentId) {
      ids.add(hoveredAgentId);
    }

    if (ids.size === 0) {
      return [] as ScenarioAgent[];
    }

    return activeScenario.agents.filter((agent) => ids.has(agent.id));
  }, [activeScenario, visibleTrajectoryIds, selectedAgentId, hoveredAgentId]);

  const updateDriveCamera = useCallback((position: { x: number; y: number }, heading: number) => {
    const baseContext = baseTransformRef.current;
    if (!baseContext) {
      return;
    }

    const { width, height } = baseContext;
    if (width === 0 || height === 0) {
      return;
    }

    const dims: CanvasDims = { width, height };
    const rotation = Math.PI / 2 - heading;
    const centerX = width / 2;
    const centerY = height / 2;
    const anchor = worldToAnchor(position, baseContext.transform, dims);
    const dx = anchor.x - centerX;
    const dy = anchor.y - centerY;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const rotatedX = dx * cos - dy * sin;
    const rotatedY = dx * sin + dy * cos;

    setCamera((prev) => {
      const zoom = prev.zoom;
      return {
        zoom,
        panX: centerX - (rotatedX * zoom + centerX),
        panY: centerY - (rotatedY * zoom + centerY),
        rotation
      };
    });
  }, [setCamera]);

  const resetCameraOrientation = useCallback(() => {
    setCamera((prev) => ({
      zoom: prev.zoom,
      panX: 0,
      panY: 0,
      rotation: 0
    }));
  }, [setCamera]);

  const applySelection = useCallback((entity?: EditingEntityRef) => {
    if (!entity) {
      clearSelection();
      return;
    }

    selectEntity(entity);

    if (entity.kind === 'agent') {
      if (editingMode === 'inspect') {
        setEditingMode('trajectory');
      }

      if (activeTool.startsWith('road')) {
        setEditingTool('trajectory-edit');
      }
    }
  }, [clearSelection, selectEntity, editingMode, setEditingMode, activeTool, setEditingTool]);

  const getEntityAtCanvasXY = useCallback((canvasX: number, canvasY: number): EditingEntityRef | undefined => {
    const baseContext = baseTransformRef.current;
    if (!baseContext || !activeScenario || !activeFrame) {
      return undefined;
    }

    const dims: CanvasDims = { width: baseContext.width, height: baseContext.height };
    const worldPoint = canvasToWorld(canvasX, canvasY, baseContext.transform, camera, dims);

    for (let index = activeFrame.agents.length - 1; index >= 0; index -= 1) {
      const agentState = activeFrame.agents[index];
      if (agentState.valid === false) {
        continue;
      }
      const agentInfo = agentById.get(agentState.id);
      if (!agentInfo) {
        continue;
      }
      if (isPointInsideAgent(worldPoint, agentState, agentInfo)) {
        return { kind: 'agent', id: agentState.id };
      }
    }

    const proximityThresholdMeters = 1.6;
    let closest: { id: string; distance: number } | undefined;

    trajectoryAgents.forEach((agent) => {
      if (agent.trajectory.length < 2) {
        return;
      }

      const distance = distanceToTrajectory(worldPoint, agent);
      if (distance <= proximityThresholdMeters && (!closest || distance < closest.distance)) {
        closest = { id: agent.id, distance };
      }
    });

    if (closest) {
      return { kind: 'agent', id: closest.id };
    }

    return undefined;
  }, [activeScenario, activeFrame, agentById, trajectoryAgents, camera]);

  const updateHoverFromEvent = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) {
      return;
    }

    const dragState = dragStateRef.current;
    if (dragState.active && dragState.pointerId === event.pointerId && dragState.hasMoved) {
      return;
    }

    const rect = canvasRef.current.getBoundingClientRect();
    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;
    const hit = getEntityAtCanvasXY(canvasX, canvasY);

    if (!hit || hit.kind !== 'agent') {
      if (editingState.hoveredEntity) {
        hoverEntity(undefined);
      }
      return;
    }

    if (!editingState.hoveredEntity || editingState.hoveredEntity.id !== hit.id) {
      hoverEntity(hit);
    }
  }, [getEntityAtCanvasXY, hoverEntity, editingState.hoveredEntity]);

  const runDriveLoop = useCallback((timestamp: number) => {
    const session = driveSessionRef.current;
    if (!session) {
      driveAnimationRef.current = null;
      return;
    }

    if (timestamp < session.lastTimestampMs) {
      session.lastTimestampMs = timestamp;
    }

    const deltaMs = timestamp - session.lastTimestampMs;
    const dt = Math.max(deltaMs, 0) / 1000;
    session.lastTimestampMs = timestamp;

    const controls = driveControlsRef.current;
    const throttleInput = (controls.forward ? 1 : 0) + (controls.backward ? -1 : 0);

    if (controls.brake) {
      if (session.speed > 0) {
        session.speed = Math.max(0, session.speed - DRIVE_CONFIG.brakeDeceleration * dt);
      } else if (session.speed < 0) {
        session.speed = Math.min(0, session.speed + DRIVE_CONFIG.brakeDeceleration * dt);
      }
    } else if (throttleInput > 0) {
      session.speed = Math.min(
        DRIVE_CONFIG.maxSpeed,
        session.speed + DRIVE_CONFIG.acceleration * throttleInput * dt
      );
    } else if (throttleInput < 0) {
      session.speed = Math.max(
        -DRIVE_CONFIG.maxReverseSpeed,
        session.speed + DRIVE_CONFIG.reverseAcceleration * throttleInput * dt
      );
    } else {
      const drag = Math.min(DRIVE_CONFIG.drag * dt, 1);
      session.speed *= Math.max(0, 1 - drag);
      if (Math.abs(session.speed) < 0.02) {
        session.speed = 0;
      }
    }

    const steerInput = (controls.right ? 1 : 0) - (controls.left ? 1 : 0);
    if (steerInput !== 0 && Math.abs(session.speed) > 0.1) {
      const speedRatio = Math.min(Math.abs(session.speed) / DRIVE_CONFIG.maxSpeed, 1);
      const direction = session.speed >= 0 ? 1 : -1;
      session.heading += steerInput * DRIVE_CONFIG.steerRate * speedRatio * dt * direction;
    }

    const distance = session.speed * dt;
    if (distance !== 0) {
      session.position.x += Math.cos(session.heading) * distance;
      session.position.y += Math.sin(session.heading) * distance;
    }

    const frameIntervalMicros = activeScenario?.metadata.frameIntervalMicros ?? DEFAULT_FRAME_INTERVAL_MICROS;
    const frameIntervalMs = Math.max(frameIntervalMicros / 1000, 1);

    while (timestamp >= session.nextSampleTimestampMs) {
      appendTrajectorySample({
        x: session.position.x,
        y: session.position.y,
        timestampMs: session.nextSampleTimestampMs
      });
      session.nextSampleTimestampMs += frameIntervalMs;
    }

    const frameCount = activeScenario?.metadata.frameCount ?? 0;
    if (frameIntervalMs > 0 && frameCount > 0) {
      const elapsedMs = timestamp - session.startTimestampMs;
      const targetFrame = Math.min(
        Math.floor(elapsedMs / frameIntervalMs),
        Math.max(frameCount - 1, 0)
      );
      setActiveFrameIndex(targetFrame);
    }

    updateDriveCamera(session.position, session.heading);

    if (driveSessionRef.current) {
      driveAnimationRef.current = requestAnimationFrame(runDriveLoop);
    } else {
      driveAnimationRef.current = null;
    }
  }, [
    activeScenario?.metadata.frameCount,
    activeScenario?.metadata.frameIntervalMicros,
    appendTrajectorySample,
    setActiveFrameIndex,
    updateDriveCamera
  ]);

  const stopDriveMode = useCallback((commit: boolean) => {
    const session = driveSessionRef.current;
    if (driveAnimationRef.current !== null) {
      cancelAnimationFrame(driveAnimationRef.current);
      driveAnimationRef.current = null;
    }

    driveSessionRef.current = null;
    driveControlsRef.current = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      brake: false
    };

    if (isDriveActive) {
      setIsDriveActive(false);
    }
    resetCameraOrientation();

    const draftSamples = editingState.trajectoryDraft?.samples ?? [];
    const samples = [...draftSamples];

    if (commit && session) {
      const finalTimestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const lastSample = samples[samples.length - 1];
      if (!lastSample || finalTimestamp - lastSample.timestampMs > 5) {
        samples.push({
          x: session.position.x,
          y: session.position.y,
          timestampMs: finalTimestamp
        });
      }

      if (activeScenarioId && samples.length >= 2) {
        const applied = applyRecordedTrajectory(activeScenarioId, session.agentId, samples);
        if (applied) {
          const agentInfo = agentById.get(session.agentId);
          const label = `Recorded drive for ${agentInfo?.displayName ?? session.agentId}`;
          completeTrajectoryRecording({ label });
        } else {
          cancelTrajectoryRecording();
        }
      } else {
        cancelTrajectoryRecording();
      }
    } else {
      cancelTrajectoryRecording();
    }

    setActiveFrameIndex(0);
    setEditingTool('trajectory-edit');
  }, [
    activeScenarioId,
    agentById,
    applyRecordedTrajectory,
    cancelTrajectoryRecording,
    completeTrajectoryRecording,
    editingState.trajectoryDraft?.samples,
    isDriveActive,
    resetCameraOrientation,
    setActiveFrameIndex,
    setEditingTool
  ]);

  useEffect(() => {
    stopDriveModeRef.current = stopDriveMode;
  }, [stopDriveMode]);

  const startDriveMode = useCallback(() => {
    if (isDriveActive || !selectedAgentId || !activeScenario) {
      return;
    }

    const agentInfo = agentById.get(selectedAgentId);
    if (!agentInfo || agentInfo.trajectory.length === 0) {
      return;
    }

    const anchorPoint = agentInfo.trajectory.find((point) => point.valid !== false) ?? agentInfo.trajectory[0];
    if (!anchorPoint) {
      return;
    }

    const frameIntervalMicros = activeScenario.metadata.frameIntervalMicros ?? DEFAULT_FRAME_INTERVAL_MICROS;
    const frameIntervalMs = Math.max(frameIntervalMicros / 1000, 1);
    const startTimestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();

    pause();
    setEditingMode('trajectory');
    setEditingTool('trajectory-drive');
    selectEntity({ kind: 'agent', id: selectedAgentId });
    setActiveFrameIndex(0);

    beginTrajectoryRecording({ agentId: selectedAgentId, startedAtMs: startTimestamp });
    appendTrajectorySample({ x: anchorPoint.x, y: anchorPoint.y, timestampMs: startTimestamp });

    driveSessionRef.current = {
      agentId: selectedAgentId,
      startTimestampMs: startTimestamp,
      lastTimestampMs: startTimestamp,
      nextSampleTimestampMs: startTimestamp + frameIntervalMs,
      position: { x: anchorPoint.x, y: anchorPoint.y },
      heading: anchorPoint.heading ?? 0,
      speed: 0
    };

    driveControlsRef.current = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      brake: false
    };

    setIsDriveActive(true);
    updateDriveCamera({ x: anchorPoint.x, y: anchorPoint.y }, anchorPoint.heading ?? 0);

    setEditingTool('trajectory-drive');

    driveAnimationRef.current = requestAnimationFrame(runDriveLoop);
  }, [
    activeScenario,
    agentById,
    appendTrajectorySample,
    beginTrajectoryRecording,
    pause,
    runDriveLoop,
    selectEntity,
    setActiveFrameIndex,
    setEditingMode,
    setEditingTool,
    selectedAgentId,
    updateDriveCamera,
    isDriveActive
  ]);

  const handleDriveToggle = useCallback(() => {
    if (isDriveActive) {
      stopDriveMode(true);
    } else {
      startDriveMode();
    }
  }, [isDriveActive, startDriveMode, stopDriveMode]);

  useEffect(() => {
    if (!isDriveActive) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const session = driveSessionRef.current;
      if (!session) {
        return;
      }

      switch (event.key) {
        case 'ArrowUp':
          driveControlsRef.current.forward = true;
          driveControlsRef.current.backward = false;
          event.preventDefault();
          break;
        case 'ArrowDown':
          driveControlsRef.current.backward = true;
          driveControlsRef.current.forward = false;
          event.preventDefault();
          break;
        case 'ArrowLeft':
          driveControlsRef.current.left = true;
          event.preventDefault();
          break;
        case 'ArrowRight':
          driveControlsRef.current.right = true;
          event.preventDefault();
          break;
        case ' ': // Spacebar
          driveControlsRef.current.brake = true;
          event.preventDefault();
          break;
        case 'Escape':
          event.preventDefault();
          stopDriveMode(false);
          break;
        case 'Enter':
          event.preventDefault();
          stopDriveMode(true);
          break;
        default:
          break;
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowUp':
          driveControlsRef.current.forward = false;
          event.preventDefault();
          break;
        case 'ArrowDown':
          driveControlsRef.current.backward = false;
          event.preventDefault();
          break;
        case 'ArrowLeft':
          driveControlsRef.current.left = false;
          event.preventDefault();
          break;
        case 'ArrowRight':
          driveControlsRef.current.right = false;
          event.preventDefault();
          break;
        case ' ': // Spacebar
          driveControlsRef.current.brake = false;
          event.preventDefault();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      driveControlsRef.current = {
        forward: false,
        backward: false,
        left: false,
        right: false,
        brake: false
      };
    };
  }, [isDriveActive, stopDriveMode]);

  useEffect(() => {
    if (!isDriveActive) {
      return;
    }

    const session = driveSessionRef.current;
    if (!session) {
      stopDriveMode(false);
      return;
    }

    if (!activeScenario) {
      stopDriveMode(false);
      return;
    }

    if (selectedAgentId && session.agentId !== selectedAgentId) {
      stopDriveMode(false);
    }
  }, [isDriveActive, activeScenario?.metadata.id, selectedAgentId, stopDriveMode]);

  useEffect(() => () => {
    if (driveAnimationRef.current !== null) {
      cancelAnimationFrame(driveAnimationRef.current);
      driveAnimationRef.current = null;
    }
    if (driveSessionRef.current) {
      const stopper = stopDriveModeRef.current;
      if (stopper) {
        stopper(false);
      } else {
        driveSessionRef.current = null;
        driveControlsRef.current = {
          forward: false,
          backward: false,
          left: false,
          right: false,
          brake: false
        };
      }
    }
  }, []);

  const handleModeChange = useCallback((mode: EditingMode) => {
    if (mode === editingMode) {
      return;
    }

    if (mode === 'inspect') {
      if (isDriveActive) {
        stopDriveMode(false);
      }
      setEditingMode(mode);
      setEditingTool('select');
      if (isRecording) {
        cancelTrajectoryRecording();
      }
      return;
    }

    setEditingMode(mode);

    if (mode === 'trajectory' && (activeTool === 'select' || activeTool.startsWith('road'))) {
      setEditingTool('trajectory-edit');
    }

    if (mode === 'road' && (activeTool === 'select' || activeTool.startsWith('trajectory'))) {
      setEditingTool('road-edit');
      if (isRecording) {
        cancelTrajectoryRecording();
      }
      if (isDriveActive) {
        stopDriveMode(false);
      }
    }
  }, [
    editingMode,
    setEditingMode,
    setEditingTool,
    activeTool,
    isRecording,
    cancelTrajectoryRecording,
    isDriveActive,
    stopDriveMode
  ]);

  const handleToolChange = useCallback((tool: EditingTool) => {
    if (tool !== activeTool) {
      setEditingTool(tool);
    }

    if (tool !== 'trajectory-record' && isRecording) {
      cancelTrajectoryRecording();
    }
    if (tool !== 'trajectory-drive' && isDriveActive) {
      stopDriveMode(false);
    }
  }, [activeTool, setEditingTool, isRecording, cancelTrajectoryRecording, isDriveActive, stopDriveMode]);


  useEffect(() => {
    setCamera({ zoom: 1, panX: 0, panY: 0, rotation: 0 });
  }, [activeScenario?.metadata.id]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const { clientWidth, clientHeight } = canvas;
    const width = Math.max(clientWidth, 1);
    const height = Math.max(clientHeight, 1);

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    if (typeof ctx.resetTransform === 'function') {
      ctx.resetTransform();
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.scale(dpr, dpr);

    ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
    ctx.fillRect(0, 0, width, height);

    if (!activeScenario || !activeFrame) {
      baseTransformRef.current = null;
      return;
    }

    const dims: CanvasDims = { width, height };
    const baseTransform = computeTransform(activeScenario.bounds, width, height);
    baseTransformRef.current = { transform: baseTransform, width, height };

    drawRoadEdges(ctx, activeScenario.roadEdges, baseTransform, camera, dims);

    trajectoryAgents.forEach((agent) => {
      const highlight = agent.id === selectedAgentId
        ? 'selected'
        : agent.id === hoveredAgentId
          ? 'hovered'
          : undefined;
      drawTrajectory(ctx, agent, baseTransform, camera, dims, { highlight });
    });

    activeFrame.agents.forEach((agentState) => {
      const agentInfo = agentById.get(agentState.id);
      let renderState = agentState;
      if (isDriveActive && driveSessionRef.current?.agentId === agentState.id) {
        const session = driveSessionRef.current;
        renderState = {
          ...agentState,
          x: session?.position.x ?? agentState.x,
          y: session?.position.y ?? agentState.y,
          heading: session?.heading ?? agentState.heading,
          speed: session?.speed ?? agentState.speed
        };
      }
      const highlight = {
        selected: renderState.id === selectedAgentId,
        hovered: renderState.id === hoveredAgentId && renderState.id !== selectedAgentId
      };
      drawAgent(ctx, renderState, baseTransform, camera, dims, agentInfo, showAgentLabels, highlight);
    });
  }, [
    activeScenario,
    activeFrame,
    activeFrameIndex,
    trajectoryAgents,
    agentById,
    camera,
    selectedAgentId,
    hoveredAgentId,
    showAgentLabels,
    isDriveActive
  ]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const isPrimaryButton = event.button === 0;
    let interactionMode: 'pan' | 'record' = 'pan';
    let targetAgentId = selectedAgentId;

    if (isPrimaryButton && isPointerRecordActive) {
      if (!targetAgentId) {
        const rect = canvas.getBoundingClientRect();
        const canvasX = event.clientX - rect.left;
        const canvasY = event.clientY - rect.top;
        const hit = getEntityAtCanvasXY(canvasX, canvasY);
        if (hit?.kind === 'agent') {
          applySelection(hit);
          targetAgentId = hit.id;
        }
      }

      if (targetAgentId && activeScenarioId) {
        interactionMode = 'record';
      }
    }

    canvas.setPointerCapture(event.pointerId);

    dragStateRef.current = {
      active: true,
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      hasMoved: false,
      mode: interactionMode
    };

    if (interactionMode === 'record' && targetAgentId && activeScenarioId) {
      const baseContext = baseTransformRef.current;
      if (!baseContext) {
        dragStateRef.current.mode = 'pan';
        setIsDragging(false);
        updateHoverFromEvent(event);
        return;
      }

      pause();
      setActiveFrameIndex(0);

      const rect = canvas.getBoundingClientRect();
      const canvasX = event.clientX - rect.left;
      const canvasY = event.clientY - rect.top;
      const dims: CanvasDims = { width: baseContext.width, height: baseContext.height };
      const worldPoint = canvasToWorld(canvasX, canvasY, baseContext.transform, camera, dims);
      const timestampMs = typeof performance !== 'undefined' ? performance.now() : Date.now();

      beginTrajectoryRecording({ agentId: targetAgentId, startedAtMs: timestampMs });
      appendTrajectorySample({
        x: worldPoint.x,
        y: worldPoint.y,
        timestampMs
      });
    } else {
      setIsDragging(false);
      updateHoverFromEvent(event);
    }
  }, [
    selectedAgentId,
    isPointerRecordActive,
    getEntityAtCanvasXY,
    applySelection,
    activeScenarioId,
    pause,
    setActiveFrameIndex,
    camera,
    beginTrajectoryRecording,
    appendTrajectorySample,
    updateHoverFromEvent
  ]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const state = dragStateRef.current;

    if (!state.active || state.pointerId !== event.pointerId) {
      updateHoverFromEvent(event);
      return;
    }

    if (state.mode === 'record') {
      const baseContext = baseTransformRef.current;
      const canvas = canvasRef.current;
      if (!baseContext || !canvas) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const canvasX = event.clientX - rect.left;
      const canvasY = event.clientY - rect.top;
      const dims: CanvasDims = { width: baseContext.width, height: baseContext.height };
      const worldPoint = canvasToWorld(canvasX, canvasY, baseContext.transform, camera, dims);
      const timestampMs = typeof performance !== 'undefined' ? performance.now() : Date.now();

      const lastSample = editingState.trajectoryDraft?.samples?.[editingState.trajectoryDraft.samples.length - 1];
      const distance = lastSample ? Math.hypot(worldPoint.x - lastSample.x, worldPoint.y - lastSample.y) : Infinity;
      const elapsedMs = lastSample ? timestampMs - lastSample.timestampMs : Infinity;

      if (distance > 0.05 || elapsedMs > 30) {
        appendTrajectorySample({
          x: worldPoint.x,
          y: worldPoint.y,
          timestampMs
        });
        state.hasMoved = true;
      }

      return;
    }

    const dx = event.clientX - state.lastX;
    const dy = event.clientY - state.lastY;
    state.lastX = event.clientX;
    state.lastY = event.clientY;

    if (!state.hasMoved) {
      const travel = Math.abs(dx) + Math.abs(dy);
      if (travel > 2) {
        state.hasMoved = true;
        setIsDragging(true);
      }
    }

    if (state.hasMoved) {
      setCamera((prev) => ({
        zoom: prev.zoom,
        panX: prev.panX + dx,
        panY: prev.panY + dy,
        rotation: prev.rotation
      }));
    }

    updateHoverFromEvent(event);
  }, [
    appendTrajectorySample,
    camera,
    editingState.trajectoryDraft,
    setCamera,
    updateHoverFromEvent
  ]);

  const releasePointerCapture = useCallback((pointerId: number) => {
    const canvas = canvasRef.current;
    if (canvas && canvas.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
  }, []);

  const resetDragState = useCallback(() => {
    dragStateRef.current = {
      active: false,
      pointerId: null,
      lastX: 0,
      lastY: 0,
      hasMoved: false,
      mode: 'pan'
    };
    setIsDragging(false);
  }, []);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const state = dragStateRef.current;

    if (state.pointerId !== event.pointerId) {
      releasePointerCapture(event.pointerId);
      resetDragState();
      return;
    }

    if (state.mode === 'record') {
      const draft = editingState.trajectoryDraft;
      const baseContext = baseTransformRef.current;
      const canvas = canvasRef.current;

      if (draft && baseContext && canvas) {
        const rect = canvas.getBoundingClientRect();
        const canvasX = event.clientX - rect.left;
        const canvasY = event.clientY - rect.top;
        const dims: CanvasDims = { width: baseContext.width, height: baseContext.height };
        const worldPoint = canvasToWorld(canvasX, canvasY, baseContext.transform, camera, dims);
        const lastSample = draft.samples[draft.samples.length - 1];
        const finalSample = {
          x: worldPoint.x,
          y: worldPoint.y,
          timestampMs: typeof performance !== 'undefined' ? performance.now() : Date.now()
        };

        const distanceToLast = lastSample
          ? Math.hypot(finalSample.x - lastSample.x, finalSample.y - lastSample.y)
          : Infinity;
        const recordedSamples =
          lastSample && distanceToLast < 0.02
            ? draft.samples
            : [...draft.samples, finalSample];

        if (activeScenarioId && draft.agentId && recordedSamples.length >= 2) {
          const didUpdate = applyRecordedTrajectory(activeScenarioId, draft.agentId, recordedSamples);
          if (didUpdate) {
            const agentInfo = agentById.get(draft.agentId);
            const label = `Recorded path for ${agentInfo?.displayName ?? draft.agentId}`;
            completeTrajectoryRecording({ label });
            setActiveFrameIndex(0);
          } else {
            cancelTrajectoryRecording();
          }
        } else {
          cancelTrajectoryRecording();
        }
      } else {
        cancelTrajectoryRecording();
      }

      releasePointerCapture(event.pointerId);
      resetDragState();
      return;
    }

    if (!state.hasMoved && event.button === 0) {
      if (canvasRef.current) {
        const rect = canvasRef.current.getBoundingClientRect();
        const canvasX = event.clientX - rect.left;
        const canvasY = event.clientY - rect.top;
        const hit = getEntityAtCanvasXY(canvasX, canvasY);
        if (hit) {
          applySelection(hit);
        } else {
          applySelection(undefined);
          hoverEntity(undefined);
        }
      }
    }

    releasePointerCapture(event.pointerId);
    resetDragState();
  }, [
    editingState.trajectoryDraft,
    activeScenarioId,
    applyRecordedTrajectory,
    agentById,
    completeTrajectoryRecording,
    setActiveFrameIndex,
    cancelTrajectoryRecording,
    camera,
    getEntityAtCanvasXY,
    applySelection,
    hoverEntity,
    releasePointerCapture,
    resetDragState
  ]);

  const handlePointerLeave = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const state = dragStateRef.current;
    if (state.pointerId === event.pointerId) {
      if (state.mode === 'record' && editingState.isRecording) {
        cancelTrajectoryRecording();
      }
      releasePointerCapture(event.pointerId);
      resetDragState();
    }
    hoverEntity(undefined);
  }, [editingState.isRecording, cancelTrajectoryRecording, releasePointerCapture, resetDragState, hoverEntity]);

  const handlePointerCancel = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const state = dragStateRef.current;
    if (state.pointerId === event.pointerId) {
      if (state.mode === 'record' && editingState.isRecording) {
        cancelTrajectoryRecording();
      }
      releasePointerCapture(event.pointerId);
      resetDragState();
    }
    hoverEntity(undefined);
  }, [editingState.isRecording, cancelTrajectoryRecording, releasePointerCapture, resetDragState, hoverEntity]);

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const canvas = canvasRef.current;
      const baseContext = baseTransformRef.current;
      if (!canvas || !baseContext) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;

      const zoomFactor = event.deltaY < 0 ? 1.1 : 0.9;

      setCamera((prev) => {
        const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.zoom * zoomFactor));
        if (Math.abs(nextZoom - prev.zoom) < 0.0001) {
          return prev;
        }

        const { transform, width, height } = baseContext;
        const dims: CanvasDims = { width, height };
        const worldPoint = canvasToWorld(pointerX, pointerY, transform, prev, dims);
        const anchor = worldToAnchor(worldPoint, transform, dims);
        const centerX = width / 2;
        const centerY = height / 2;

        const panX = pointerX - ((anchor.x - centerX) * nextZoom + centerX);
        const panY = pointerY - ((anchor.y - centerY) * nextZoom + centerY);

        return {
          zoom: nextZoom,
          panX,
          panY,
          rotation: prev.rotation
        };
      });
    },
    []
  );

  const stageClassName = [
    'viewer__stage',
    isDragging ? 'viewer__stage--dragging' : '',
    isEditMode ? 'viewer__stage--editing' : ''
  ].filter(Boolean).join(' ');

  return (
    <section className="viewer">
      <header className="viewer__header">
        <h2>Top-Down Preview</h2>
        {summary && (
          <div className="viewer__summary">
            <span>{summary.agentCount} agents</span>
            <span>{summary.roadEdgeCount} road edges</span>
            <span>{summary.frameCount} frames</span>
            <span>{summary.durationSeconds.toFixed(1)}s</span>
          </div>
        )}
      </header>

      <div className={stageClassName}>
        <canvas
          ref={canvasRef}
          className="viewer__canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onPointerCancel={handlePointerCancel}
          onWheel={handleWheel}
        />
        <div className="viewer__toolbar">
          <div className="viewer__toolbar-row">
            <span className="viewer__toolbar-label">Mode</span>
            <div className="viewer__toolbar-buttons">
              <button
                type="button"
                className="button button--secondary"
                aria-pressed={editingMode === 'inspect'}
                onClick={() => handleModeChange('inspect')}
              >
                Inspect
              </button>
              <button
                type="button"
                className="button button--secondary"
                aria-pressed={editingMode === 'trajectory'}
                onClick={() => handleModeChange('trajectory')}
              >
                Trajectory
              </button>
              <button
                type="button"
                className="button button--secondary"
                aria-pressed={editingMode === 'road'}
                onClick={() => handleModeChange('road')}
              >
                Road
              </button>
            </div>
          </div>

          {isTrajectoryMode && (
            <div className="viewer__toolbar-row">
              <span className="viewer__toolbar-label">Trajectory</span>
              <div className="viewer__toolbar-buttons">
                <button
                  type="button"
                  className="button button--secondary"
                  aria-pressed={activeTool === 'trajectory-edit'}
                  onClick={() => handleToolChange('trajectory-edit')}
                >
                  Adjust Path
                </button>
                <button
                  type="button"
                  className="button button--secondary"
                  aria-pressed={isPointerRecordActive || isPointerRecording}
                  onClick={() => handleToolChange('trajectory-record')}
                  disabled={isDriveActive}
                >
                  {isPointerRecording ? 'Recording…' : 'Record Path'}
                </button>
                <button
                  type="button"
                  className="button button--secondary"
                  aria-pressed={isDriveActive}
                  onClick={handleDriveToggle}
                  disabled={!selectedAgentId}
                >
                  {isDriveActive ? 'Stop Drive' : 'Drive Agent'}
                </button>
              </div>
            </div>
          )}

          {isRoadMode && (
            <div className="viewer__toolbar-row">
              <span className="viewer__toolbar-label">Road</span>
              <div className="viewer__toolbar-buttons">
                <button
                  type="button"
                  className="button button--secondary"
                  aria-pressed={activeTool === 'road-edit'}
                  onClick={() => handleToolChange('road-edit')}
                >
                  Edit Geometry
                </button>
                <button
                  type="button"
                  className="button button--secondary"
                  aria-pressed={activeTool === 'road-add'}
                  onClick={() => handleToolChange('road-add')}
                >
                  Draw Road
                </button>
              </div>
            </div>
          )}

          {isDriveActive && (
            <div className="viewer__toolbar-banner">
              <span>Drive mode – arrow keys steer, space brakes, Enter to save, Esc to cancel</span>
            </div>
          )}
          {!isDriveActive && isPointerRecording && (
            <div className="viewer__toolbar-banner">
              <span>Recording path… playback reset to frame 0</span>
            </div>
          )}
        </div>
        {!activeFrame && <p className="viewer__overlay">Load or create a scenario to start exploring the scene.</p>}
      </div>
    </section>
  );
}

export default ScenarioViewer;
