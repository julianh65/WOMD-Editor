import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  useScenarioStore,
  type EditingEntityRef,
  type EditingMode,
  type EditingTool
} from '@/state/scenarioStore';
import { RoadEdge, ScenarioAgent, ScenarioBounds, ScenarioFrameAgentState, TrajectoryPoint } from '@/types/scenario';
import { TOOLBAR_ICONS } from './toolbarIcons';

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
  variant?: 'ghost';
};

type DragMode = 'pan' | 'record' | 'gizmo-translate-x' | 'gizmo-translate-y' | 'gizmo-rotate';

interface DragGizmoState {
  kind: 'translate' | 'rotate';
  axis?: 'x' | 'y';
  startAnchor: { x: number; y: number };
  startHeading: number;
  startPointerWorld: { x: number; y: number };
  startPointerAngle?: number;
  changed: boolean;
}

interface DragState {
  active: boolean;
  pointerId: number | null;
  lastX: number;
  lastY: number;
  hasMoved: boolean;
  mode: DragMode;
  gizmo?: DragGizmoState;
}

type AgentHighlightState = {
  selected?: boolean;
  hovered?: boolean;
  driving?: boolean;
};

interface BaseTransformContext {
  transform: CanvasTransform;
  width: number;
  height: number;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const DEFAULT_FRAME_INTERVAL_MICROS = 100_000;
const DRIVE_SETTINGS_DEFAULT: DriveSettings = {
  maxSpeed: 38,
  maxReverseSpeed: 12,
  acceleration: 24,
  reverseAcceleration: 11,
  brakeDeceleration: 20,
  drag: 0.85,
  steerRate: 8.0
};

const DRIVE_KEY_CODES = new Set([
  'ArrowUp',
  'KeyW',
  'ArrowDown',
  'KeyS',
  'ArrowLeft',
  'KeyA',
  'ArrowRight',
  'KeyD',
  'Space'
]);

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

interface DriveSettings {
  maxSpeed: number;
  maxReverseSpeed: number;
  acceleration: number;
  reverseAcceleration: number;
  brakeDeceleration: number;
  drag: number;
  steerRate: number;
}

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

const GIZMO_TRANSLATE_LENGTH = 3;
const GIZMO_ROTATION_RADIUS = 4;
const GIZMO_HANDLE_HIT_RADIUS = 18;
const GIZMO_ROTATION_HIT_TOLERANCE = 14;

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
  const isGhost = options.variant === 'ghost';
  if (isGhost) {
    const dash = 10;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
    ctx.lineWidth = 2.1;
    ctx.setLineDash([dash, dash]);
  } else {
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
  }

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

function isGizmoMode(mode: DragMode): boolean {
  return mode === 'gizmo-translate-x' || mode === 'gizmo-translate-y' || mode === 'gizmo-rotate';
}

function normalizeAngle(angle: number): number {
  let next = angle;
  while (next <= -Math.PI) {
    next += Math.PI * 2;
  }
  while (next > Math.PI) {
    next -= Math.PI * 2;
  }
  return next;
}

function drawTransformGizmo(
  ctx: CanvasRenderingContext2D,
  base: CanvasTransform,
  camera: CameraState,
  dims: CanvasDims,
  anchor: TrajectoryPoint
) {
  const anchorScreen = worldToCanvas(anchor, base, camera, dims);
  const xHandleWorld = { x: anchor.x + GIZMO_TRANSLATE_LENGTH, y: anchor.y };
  const yHandleWorld = { x: anchor.x, y: anchor.y + GIZMO_TRANSLATE_LENGTH };
  const xHandle = worldToCanvas(xHandleWorld, base, camera, dims);
  const yHandle = worldToCanvas(yHandleWorld, base, camera, dims);
  const rotationRef = worldToCanvas({ x: anchor.x + GIZMO_ROTATION_RADIUS, y: anchor.y }, base, camera, dims);
  const rotationRadius = Math.hypot(rotationRef.x - anchorScreen.x, rotationRef.y - anchorScreen.y);
  const lineWidth = Math.max(2.2, 3 / camera.zoom);

  ctx.save();
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';

  // X axis handle (right / east)
  ctx.strokeStyle = 'rgba(59, 130, 246, 0.95)';
  ctx.beginPath();
  ctx.moveTo(anchorScreen.x, anchorScreen.y);
  ctx.lineTo(xHandle.x, xHandle.y);
  ctx.stroke();
  const arrowSizeX = Math.max(6, 10 / camera.zoom);
  const dirX = Math.atan2(xHandle.y - anchorScreen.y, xHandle.x - anchorScreen.x);
  ctx.beginPath();
  ctx.moveTo(xHandle.x, xHandle.y);
  ctx.lineTo(xHandle.x - Math.cos(dirX - Math.PI / 6) * arrowSizeX, xHandle.y - Math.sin(dirX - Math.PI / 6) * arrowSizeX);
  ctx.lineTo(xHandle.x - Math.cos(dirX + Math.PI / 6) * arrowSizeX, xHandle.y - Math.sin(dirX + Math.PI / 6) * arrowSizeX);
  ctx.closePath();
  ctx.fillStyle = 'rgba(59, 130, 246, 0.9)';
  ctx.fill();

  // Y axis handle (up / north)
  ctx.strokeStyle = 'rgba(249, 115, 22, 0.95)';
  ctx.beginPath();
  ctx.moveTo(anchorScreen.x, anchorScreen.y);
  ctx.lineTo(yHandle.x, yHandle.y);
  ctx.stroke();
  const arrowSizeY = arrowSizeX;
  const dirY = Math.atan2(yHandle.y - anchorScreen.y, yHandle.x - anchorScreen.x);
  ctx.beginPath();
  ctx.moveTo(yHandle.x, yHandle.y);
  ctx.lineTo(yHandle.x - Math.cos(dirY - Math.PI / 6) * arrowSizeY, yHandle.y - Math.sin(dirY - Math.PI / 6) * arrowSizeY);
  ctx.lineTo(yHandle.x - Math.cos(dirY + Math.PI / 6) * arrowSizeY, yHandle.y - Math.sin(dirY + Math.PI / 6) * arrowSizeY);
  ctx.closePath();
  ctx.fillStyle = 'rgba(249, 115, 22, 0.85)';
  ctx.fill();

  // Rotation ring
  ctx.setLineDash([12 / Math.max(camera.zoom, 0.001), 10 / Math.max(camera.zoom, 0.001)]);
  ctx.strokeStyle = 'rgba(236, 72, 153, 0.8)';
  ctx.beginPath();
  ctx.arc(anchorScreen.x, anchorScreen.y, rotationRadius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Rotation handle indicator at 0° (east)
  ctx.beginPath();
  ctx.fillStyle = 'rgba(236, 72, 153, 0.9)';
  ctx.arc(anchorScreen.x + rotationRadius, anchorScreen.y, Math.max(5, 7 / camera.zoom), 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function hitTestGizmo(
  canvasX: number,
  canvasY: number,
  base: CanvasTransform,
  camera: CameraState,
  dims: CanvasDims,
  anchor: TrajectoryPoint
): DragMode | undefined {
  const anchorScreen = worldToCanvas(anchor, base, camera, dims);
  const xHandle = worldToCanvas({ x: anchor.x + GIZMO_TRANSLATE_LENGTH, y: anchor.y }, base, camera, dims);
  const yHandle = worldToCanvas({ x: anchor.x, y: anchor.y + GIZMO_TRANSLATE_LENGTH }, base, camera, dims);
  const rotationRef = worldToCanvas({ x: anchor.x + GIZMO_ROTATION_RADIUS, y: anchor.y }, base, camera, dims);
  const rotationRadius = Math.hypot(rotationRef.x - anchorScreen.x, rotationRef.y - anchorScreen.y);
  const distanceToAnchor = Math.hypot(canvasX - anchorScreen.x, canvasY - anchorScreen.y);

  if (Math.hypot(canvasX - xHandle.x, canvasY - xHandle.y) <= GIZMO_HANDLE_HIT_RADIUS) {
    return 'gizmo-translate-x';
  }

  if (Math.hypot(canvasX - yHandle.x, canvasY - yHandle.y) <= GIZMO_HANDLE_HIT_RADIUS) {
    return 'gizmo-translate-y';
  }

  if (Math.abs(distanceToAnchor - rotationRadius) <= GIZMO_ROTATION_HIT_TOLERANCE) {
    return 'gizmo-rotate';
  }

  return undefined;
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
  const isDriving = Boolean(highlight?.driving);
  const fillColour = isDriving ? '#f97316' : colours.fill;
  const strokeColour = isDriving ? '#fb923c' : colours.stroke;

  ctx.save();
  ctx.translate(x, y);
  const headingValue = agentState.heading ?? 0;
  const rotation = -headingValue;
  ctx.rotate(rotation);
  ctx.fillStyle = fillColour;
  ctx.strokeStyle = strokeColour;
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
    const selectedStroke = agentInfo?.isExpert
      ? 'rgba(14, 165, 233, 0.95)'
      : 'rgba(250, 204, 21, 0.92)';
    ctx.strokeStyle = isSelected ? selectedStroke : 'rgba(94, 234, 212, 0.9)';
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
    play,
    isPlaying,
    setActiveFrameIndex,
    applyRecordedTrajectory,
    updateAgentStartPose,
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
    completeTrajectoryRecording,
    pushHistoryEntry
  } = editing;
  const rotationMode = editingState.rotationMode;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseTransformRef = useRef<BaseTransformContext | null>(null);
  const dragStateRef = useRef<DragState>({
    active: false,
    pointerId: null,
    lastX: 0,
    lastY: 0,
    hasMoved: false,
    mode: 'pan',
    gizmo: undefined
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
  const drivePressedKeysRef = useRef<Set<string>>(new Set());
  const stopDriveModeRef = useRef<DriveModeStopper | null>(null);
  const [driveSettings, setDriveSettings] = useState<DriveSettings>(DRIVE_SETTINGS_DEFAULT);
  const driveSettingsRef = useRef<DriveSettings>(driveSettings);
  const wasPlayingRef = useRef(false);
  useEffect(() => {
    driveSettingsRef.current = driveSettings;
  }, [driveSettings]);
  const editingMode = editingState.mode;
  const activeTool = editingState.activeTool;
  const isRecording = editingState.isRecording;
  const selectedAgentId = editingState.selectedEntity?.kind === 'agent' ? editingState.selectedEntity.id : undefined;
  const hoveredAgentId = editingState.hoveredEntity?.kind === 'agent' ? editingState.hoveredEntity.id : undefined;
  const isEditMode = editingMode === 'trajectory' || editingMode === 'road';
  const isTrajectoryMode = editingMode === 'trajectory';
  const isRoadMode = editingMode === 'road';
  const isPointerRecordTool = activeTool === 'trajectory-record';
  const isDriveToolSelected = activeTool === 'trajectory-drive';
  const isPointerRecordActive = isPointerRecordTool && !isDriveActive;
  const isPointerRecording = isRecording && !isDriveActive;
  const trajectoryDraft = editingState.trajectoryDraft;

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

  const selectedAgentInfo = useMemo(() => {
    if (!selectedAgentId) {
      return undefined;
    }
    return agentById.get(selectedAgentId);
  }, [agentById, selectedAgentId]);

  const selectedAnchorPoint = useMemo(() => {
    if (!selectedAgentInfo) {
      return undefined;
    }

    return selectedAgentInfo.trajectory.find((point) => point.valid !== false) ?? selectedAgentInfo.trajectory[0];
  }, [selectedAgentInfo]);

  const updateDriveCamera = useCallback((position: { x: number; y: number }) => {
    const baseContext = baseTransformRef.current;
    if (!baseContext) {
      return;
    }

    const { width, height } = baseContext;
    if (width === 0 || height === 0) {
      return;
    }

    const dims: CanvasDims = { width, height };
    const centerX = width / 2;
    const centerY = height / 2;
    const anchor = worldToAnchor(position, baseContext.transform, dims);
    const dx = anchor.x - centerX;
    const dy = anchor.y - centerY;

    setCamera((prev) => {
      const zoom = prev.zoom;
      return {
        zoom,
        panX: -(dx * zoom),
        panY: -(dy * zoom),
        rotation: 0
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

    if (entity.kind === 'agent' && activeTool.startsWith('road')) {
      setEditingTool('trajectory-edit');
    }
  }, [clearSelection, selectEntity, activeTool, setEditingTool]);

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

  const syncDriveControls = useCallback(() => {
    const pressed = drivePressedKeysRef.current;
    const controls: DriveControlsState = {
      forward: pressed.has('ArrowUp') || pressed.has('KeyW'),
      backward: pressed.has('ArrowDown') || pressed.has('KeyS'),
      left: pressed.has('ArrowLeft') || pressed.has('KeyA'),
      right: pressed.has('ArrowRight') || pressed.has('KeyD'),
      brake: pressed.has('Space')
    };
    driveControlsRef.current = controls;
    return controls;
  }, []);

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

    const controls = syncDriveControls();
    const settings = driveSettingsRef.current;
    const throttleInput = (controls.forward ? 1 : 0) + (controls.backward ? -1 : 0);

    const steerInput = (controls.right ? 1 : 0) - (controls.left ? 1 : 0);

    // Update speed (longitudinal motion)
    let nextSpeed = session.speed;
    if (controls.brake) {
      if (nextSpeed > 0) {
        nextSpeed = Math.max(0, nextSpeed - settings.brakeDeceleration * dt);
      } else if (nextSpeed < 0) {
        nextSpeed = Math.min(0, nextSpeed + settings.brakeDeceleration * dt);
      }
    } else if (throttleInput > 0) {
      const speedAbs = Math.abs(nextSpeed);
      const launchBoost = 1 + Math.max(0, 4 - speedAbs) * 0.25;
      nextSpeed = Math.min(
        settings.maxSpeed,
        nextSpeed + settings.acceleration * throttleInput * launchBoost * dt
      );
    } else if (throttleInput < 0) {
      const speedAbs = Math.abs(nextSpeed);
      const reverseBoost = 1 + Math.max(0, 3 - speedAbs) * 0.2;
      nextSpeed = Math.max(
        -settings.maxReverseSpeed,
        nextSpeed + settings.reverseAcceleration * throttleInput * reverseBoost * dt
      );
    } else if (Math.abs(nextSpeed) < 0.02) {
      nextSpeed = 0;
    }
    session.speed = nextSpeed;

    // Update heading (lateral motion)
    if (steerInput !== 0) {
      const speedAbs = Math.abs(session.speed);
      const speedRatio = settings.maxSpeed > 0 ? Math.min(speedAbs / settings.maxSpeed, 1) : 0;
      const hasThrottle = Math.abs(throttleInput) > 0;
      const hasBrake = controls.brake;
      const baseMin = hasThrottle ? 0.75 : hasBrake ? 0.5 : 0;
      const effectiveRatio = Math.max(speedRatio, baseMin);
      const steerDelta = -steerInput * settings.steerRate * effectiveRatio * dt;
      session.heading += steerDelta;
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

    updateDriveCamera(session.position);

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
    updateDriveCamera,
    syncDriveControls
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
    drivePressedKeysRef.current.clear();
    syncDriveControls();

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
    syncDriveControls,
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
    selectEntity({ kind: 'agent', id: selectedAgentId });
    setActiveFrameIndex(0);

    beginTrajectoryRecording({ agentId: selectedAgentId, startedAtMs: startTimestamp });
    setEditingTool('trajectory-drive');
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
    drivePressedKeysRef.current.clear();
    syncDriveControls();

    setIsDriveActive(true);
    updateDriveCamera({ x: anchorPoint.x, y: anchorPoint.y });
    driveAnimationRef.current = requestAnimationFrame(runDriveLoop);
    // Give keyboard focus to the canvas for reliable multi-key input
    setTimeout(() => {
      try {
        canvasRef.current?.focus?.();
      } catch {}
    }, 0);
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
    isDriveActive,
    syncDriveControls
  ]);

  const handleDriveToggle = useCallback(() => {
    if (isDriveActive) {
      stopDriveMode(true);
    } else {
      startDriveMode();
    }
  }, [isDriveActive, startDriveMode, stopDriveMode]);

  const handleDriveSettingChange = useCallback((key: keyof DriveSettings, value: number) => {
    setDriveSettings((prev) => {
      const next = { ...prev, [key]: value };
      if (key === 'maxSpeed') {
        next.maxReverseSpeed = Math.max(4, value * 0.32);
      }
      if (key === 'acceleration') {
        next.reverseAcceleration = Math.max(3, value * 0.7);
        next.brakeDeceleration = Math.max(value * 1.05, prev.brakeDeceleration);
      }
      if (key === 'steerRate') {
        next.steerRate = Math.max(0.6, value);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!isDriveActive) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const session = driveSessionRef.current;
      if (!session) {
        return;
      }

      if (event.code === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') {
          event.stopImmediatePropagation();
        }
        stopDriveMode(false);
        return;
      }

      if (event.code === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') {
          event.stopImmediatePropagation();
        }
        stopDriveMode(true);
        return;
      }

      if (!DRIVE_KEY_CODES.has(event.code)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation();
      }

      drivePressedKeysRef.current.add(event.code);
      syncDriveControls();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (!DRIVE_KEY_CODES.has(event.code)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation();
      }

      drivePressedKeysRef.current.delete(event.code);
      syncDriveControls();
    };

    window.addEventListener('keydown', handleKeyDown, { passive: false, capture: true });
    window.addEventListener('keyup', handleKeyUp, { passive: false, capture: true });

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true } as any);
      window.removeEventListener('keyup', handleKeyUp, { capture: true } as any);
      drivePressedKeysRef.current.clear();
      driveControlsRef.current = {
        forward: false,
        backward: false,
        left: false,
        right: false,
        brake: false
      };
      syncDriveControls();
    };
  }, [isDriveActive, stopDriveMode, syncDriveControls]);

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
        drivePressedKeysRef.current.clear();
        syncDriveControls();
      }
    }
  }, [syncDriveControls]);

  const handleModeChange = useCallback((mode: EditingMode) => {
    if (mode === editingMode) {
      return;
    }

    setEditingMode(mode);

    if (mode === 'trajectory' && (activeTool === 'select' || activeTool.startsWith('road'))) {
      setEditingTool('trajectory-edit');
    }

    if (mode === 'road') {
      if (activeTool === 'select' || activeTool.startsWith('trajectory')) {
        setEditingTool('road-edit');
      }
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
  }, [activeScenario?.metadata.id, setCamera]);

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

    const drivingAgentId = driveSessionRef.current?.agentId;

    const recordingAgentId = isPointerRecording ? trajectoryDraft?.agentId : undefined;
    trajectoryAgents.forEach((agent) => {
      const isDrivingAgent = isDriveActive && drivingAgentId === agent.id;
      const isRecordingAgent = recordingAgentId === agent.id;
      const highlight = isDrivingAgent
        ? 'selected'
        : agent.id === selectedAgentId
          ? 'selected'
          : agent.id === hoveredAgentId
            ? 'hovered'
            : undefined;

      if (isRecordingAgent) {
        drawTrajectory(ctx, agent, baseTransform, camera, dims, { variant: 'ghost' });
      } else {
        drawTrajectory(ctx, agent, baseTransform, camera, dims, { highlight });
      }
    });

    if (trajectoryDraft && trajectoryDraft.samples.length > 0) {
      ctx.save();
      const dashLength = 8 / Math.max(camera.zoom, 0.0001);
      ctx.lineWidth = Math.max(2.4, 2.4 / camera.zoom);
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.85)';
      ctx.setLineDash([dashLength, dashLength]);

      const first = worldToCanvas(trajectoryDraft.samples[0], baseTransform, camera, dims);
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < trajectoryDraft.samples.length; i += 1) {
        const point = worldToCanvas(trajectoryDraft.samples[i], baseTransform, camera, dims);
        ctx.lineTo(point.x, point.y);
      }
      ctx.stroke();

      ctx.setLineDash([]);
      const tipPoint = worldToCanvas(
        trajectoryDraft.samples[trajectoryDraft.samples.length - 1],
        baseTransform,
        camera,
        dims
      );
      const tipRadius = Math.max(4, 6 / camera.zoom);
      ctx.beginPath();
      ctx.fillStyle = 'rgba(250, 204, 21, 0.9)';
      ctx.arc(tipPoint.x, tipPoint.y, tipRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    activeFrame.agents.forEach((agentState) => {
      const agentInfo = agentById.get(agentState.id);
      const isDrivingAgent = isDriveActive && drivingAgentId === agentState.id;
      let renderState = agentState;
      if (isDrivingAgent) {
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
        selected: renderState.id === selectedAgentId || isDrivingAgent,
        hovered: renderState.id === hoveredAgentId && renderState.id !== selectedAgentId,
        driving: isDrivingAgent
      };
      drawAgent(ctx, renderState, baseTransform, camera, dims, agentInfo, showAgentLabels, highlight);
    });

    if (selectedAnchorPoint && selectedAgentInfo && !isDriveActive) {
      drawTransformGizmo(ctx, baseTransform, camera, dims, selectedAnchorPoint);
    }
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
    isDriveActive,
    trajectoryDraft,
    selectedAnchorPoint,
    selectedAgentInfo
  ]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const baseContext = baseTransformRef.current;
    const rect = canvas.getBoundingClientRect();
    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;
    const isPrimaryButton = event.button === 0;

    if (
      isPrimaryButton &&
      baseContext &&
      selectedAgentId &&
      selectedAnchorPoint &&
      !isPointerRecordActive
    ) {
      const dims: CanvasDims = { width: baseContext.width, height: baseContext.height };
      const gizmoMode = hitTestGizmo(canvasX, canvasY, baseContext.transform, camera, dims, selectedAnchorPoint);
      if (gizmoMode) {
        canvas.setPointerCapture(event.pointerId);
        const pointerWorld = canvasToWorld(canvasX, canvasY, baseContext.transform, camera, dims);
        const pointerAngle = Math.atan2(pointerWorld.y - selectedAnchorPoint.y, pointerWorld.x - selectedAnchorPoint.x);
        dragStateRef.current = {
          active: true,
          pointerId: event.pointerId,
          lastX: event.clientX,
          lastY: event.clientY,
          hasMoved: false,
          mode: gizmoMode,
          gizmo: {
            kind: gizmoMode === 'gizmo-rotate' ? 'rotate' : 'translate',
            axis: gizmoMode === 'gizmo-translate-x' ? 'x' : gizmoMode === 'gizmo-translate-y' ? 'y' : undefined,
            startAnchor: { x: selectedAnchorPoint.x, y: selectedAnchorPoint.y },
            startHeading: selectedAnchorPoint.heading ?? 0,
            startPointerWorld: pointerWorld,
            startPointerAngle: gizmoMode === 'gizmo-rotate' ? pointerAngle : undefined,
            changed: false
          }
        };
        setIsDragging(false);
        return;
      }
    }

    let interactionMode: 'pan' | 'record' = 'pan';
    let targetAgentId = selectedAgentId;

    if (isPrimaryButton && isPointerRecordActive) {
      if (!targetAgentId) {
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
      mode: interactionMode,
      gizmo: undefined
    };

    if (interactionMode === 'record' && targetAgentId && activeScenarioId) {
      if (!baseContext) {
        dragStateRef.current.mode = 'pan';
        setIsDragging(false);
        updateHoverFromEvent(event);
        return;
      }

      wasPlayingRef.current = isPlaying;
      if (!isPlaying) {
        play();
      }

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
    isPlaying,
    play,
    camera,
    beginTrajectoryRecording,
    appendTrajectorySample,
    updateHoverFromEvent,
    selectedAnchorPoint
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

    if (isGizmoMode(state.mode)) {
      const baseContext = baseTransformRef.current;
      const canvas = canvasRef.current;
      const gizmo = state.gizmo;
      if (!baseContext || !canvas || !gizmo || !activeScenarioId || !selectedAgentId) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const canvasX = event.clientX - rect.left;
      const canvasY = event.clientY - rect.top;
      const dims: CanvasDims = { width: baseContext.width, height: baseContext.height };
      const pointerWorld = canvasToWorld(canvasX, canvasY, baseContext.transform, camera, dims);

      if (gizmo.kind === 'translate' && gizmo.axis) {
        const dx = pointerWorld.x - gizmo.startPointerWorld.x;
        const dy = pointerWorld.y - gizmo.startPointerWorld.y;
        const delta = gizmo.axis === 'x' ? dx : dy;
        const nextX = gizmo.startAnchor.x + (gizmo.axis === 'x' ? delta : 0);
        const nextY = gizmo.startAnchor.y + (gizmo.axis === 'y' ? delta : 0);
        updateAgentStartPose(activeScenarioId, selectedAgentId, {
          x: nextX,
          y: nextY
        });
        state.gizmo = {
          ...gizmo,
          changed: true
        };
      } else if (gizmo.kind === 'rotate') {
        const anchor = gizmo.startAnchor;
        const angle = Math.atan2(pointerWorld.y - anchor.y, pointerWorld.x - anchor.x);
        const deltaAngle = normalizeAngle(angle - (gizmo.startPointerAngle ?? angle));
        const nextHeading = normalizeAngle(gizmo.startHeading + deltaAngle);
        updateAgentStartPose(activeScenarioId, selectedAgentId, {
          headingRadians: nextHeading
        }, { rotationMode });
        state.gizmo = {
          ...gizmo,
          changed: true
        };
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
    updateHoverFromEvent,
    activeScenarioId,
    selectedAgentId,
    updateAgentStartPose,
    rotationMode
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
      mode: 'pan',
      gizmo: undefined
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
          } else {
            cancelTrajectoryRecording();
          }
        } else {
          cancelTrajectoryRecording();
        }
      } else {
        cancelTrajectoryRecording();
      }

      if (!wasPlayingRef.current) {
        pause();
      }
      wasPlayingRef.current = false;

      releasePointerCapture(event.pointerId);
      resetDragState();
      return;
    }

    if (isGizmoMode(state.mode)) {
      const gizmo = state.gizmo;
      if (gizmo?.changed && activeScenarioId && selectedAgentId) {
        const agentInfo = agentById.get(selectedAgentId);
        const now = Date.now();
        const actionLabel = gizmo.kind === 'rotate'
          ? `Rotated start pose`
          : gizmo.axis === 'x'
            ? `Moved start pose (X)`
            : `Moved start pose (Y)`;
        pushHistoryEntry({
          id: `gizmo-${selectedAgentId}-${now.toString(36)}`,
          label: `${actionLabel} for ${agentInfo?.displayName ?? selectedAgentId}`,
          timestamp: now
        });
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
    pause,
    cancelTrajectoryRecording,
    camera,
    getEntityAtCanvasXY,
    applySelection,
    hoverEntity,
    wasPlayingRef,
    releasePointerCapture,
    resetDragState,
    selectedAgentId,
    pushHistoryEntry
  ]);

  const handlePointerLeave = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const state = dragStateRef.current;
    if (state.pointerId === event.pointerId) {
      if (state.mode === 'record' && editingState.isRecording) {
        cancelTrajectoryRecording();
        if (!wasPlayingRef.current) {
          pause();
        }
        wasPlayingRef.current = false;
      } else if (isGizmoMode(state.mode)) {
        const gizmo = state.gizmo;
        if (gizmo?.changed && activeScenarioId && selectedAgentId) {
          const agentInfo = agentById.get(selectedAgentId);
          const now = Date.now();
          const actionLabel = gizmo.kind === 'rotate'
            ? `Rotated start pose`
            : gizmo.axis === 'x'
              ? `Moved start pose (X)`
              : `Moved start pose (Y)`;
          pushHistoryEntry({
            id: `gizmo-${selectedAgentId}-${now.toString(36)}`,
            label: `${actionLabel} for ${agentInfo?.displayName ?? selectedAgentId}`,
            timestamp: now
          });
        }
      }
      releasePointerCapture(event.pointerId);
      resetDragState();
    }
    hoverEntity(undefined);
  }, [
    editingState.isRecording,
    cancelTrajectoryRecording,
    pause,
    releasePointerCapture,
    resetDragState,
    hoverEntity,
    activeScenarioId,
    selectedAgentId,
    agentById,
    pushHistoryEntry
  ]);

  const handlePointerCancel = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const state = dragStateRef.current;
    if (state.pointerId === event.pointerId) {
      if (state.mode === 'record' && editingState.isRecording) {
        cancelTrajectoryRecording();
      } else if (isGizmoMode(state.mode)) {
        const gizmo = state.gizmo;
        if (gizmo?.changed && activeScenarioId && selectedAgentId) {
          const agentInfo = agentById.get(selectedAgentId);
          const now = Date.now();
          const actionLabel = gizmo.kind === 'rotate'
            ? `Rotated start pose`
            : gizmo.axis === 'x'
              ? `Moved start pose (X)`
              : `Moved start pose (Y)`;
          pushHistoryEntry({
            id: `gizmo-${selectedAgentId}-${now.toString(36)}`,
            label: `${actionLabel} for ${agentInfo?.displayName ?? selectedAgentId}`,
            timestamp: now
          });
        }
      }
      releasePointerCapture(event.pointerId);
      resetDragState();
    }
    hoverEntity(undefined);
  }, [
    editingState.isRecording,
    cancelTrajectoryRecording,
    releasePointerCapture,
    resetDragState,
    hoverEntity,
    activeScenarioId,
    selectedAgentId,
    agentById,
    pushHistoryEntry
  ]);

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
          tabIndex={0}
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
                className="button button--secondary viewer__toolbar-button"
                aria-pressed={editingMode === 'trajectory'}
                onClick={() => handleModeChange('trajectory')}
              >
                <span className="viewer__toolbar-button-icon" aria-hidden="true">{TOOLBAR_ICONS.trajectory}</span>
                <span>Trajectory</span>
              </button>
              <button
                type="button"
                className="button button--secondary viewer__toolbar-button"
                aria-pressed={editingMode === 'road'}
                onClick={() => handleModeChange('road')}
              >
                <span className="viewer__toolbar-button-icon" aria-hidden="true">{TOOLBAR_ICONS.road}</span>
                <span>Road</span>
              </button>
            </div>
          </div>

          {isTrajectoryMode && (
            <div className="viewer__toolbar-row">
              <span className="viewer__toolbar-label">Trajectory</span>
              <div className="viewer__toolbar-buttons">
                <button
                  type="button"
                  className="button button--secondary viewer__toolbar-button"
                  aria-pressed={activeTool === 'trajectory-edit'}
                  onClick={() => handleToolChange('trajectory-edit')}
                >
                  <span className="viewer__toolbar-button-icon" aria-hidden="true">{TOOLBAR_ICONS.adjust}</span>
                  <span>Adjust Path</span>
                </button>
                <button
                  type="button"
                  className="button button--secondary viewer__toolbar-button"
                  aria-pressed={isPointerRecordActive || isPointerRecording}
                  onClick={() => handleToolChange('trajectory-record')}
                  disabled={isDriveActive}
                >
                  <span className="viewer__toolbar-button-icon" aria-hidden="true">{TOOLBAR_ICONS.record}</span>
                  <span>{isPointerRecording ? 'Recording…' : 'Record Path'}</span>
                </button>
                <button
                  type="button"
                  className="button button--secondary viewer__toolbar-button"
                  aria-pressed={isDriveActive}
                  onClick={handleDriveToggle}
                  disabled={!selectedAgentId}
                >
                  <span className="viewer__toolbar-button-icon" aria-hidden="true">{TOOLBAR_ICONS.drive}</span>
                  <span className="viewer__toolbar-button-text">
                    <span>{isDriveActive ? 'Stop Drive' : 'Drive Agent'}</span>
                    <span className="viewer__toolbar-button-note">Experimental · clunky</span>
                  </span>
                </button>
              </div>
            </div>
          )}

          {isTrajectoryMode && (isDriveToolSelected || isDriveActive) && (
            <div className="viewer__toolbar-row viewer__toolbar-row--settings">
              <span className="viewer__toolbar-label">Drive Tune</span>
              <div className="viewer__toolbar-settings">
                <label>
                  <span>Max Speed {Math.round(driveSettings.maxSpeed * 3.6)} km/h</span>
                  <input
                    type="range"
                    min="8"
                    max="54"
                    step="1"
                    value={driveSettings.maxSpeed}
                    onChange={(event) => handleDriveSettingChange('maxSpeed', Number(event.target.value))}
                  />
                </label>
                <label>
                  <span>Acceleration {driveSettings.acceleration.toFixed(1)} m/s²</span>
                  <input
                    type="range"
                    min="4"
                    max="28"
                    step="0.5"
                    value={driveSettings.acceleration}
                    onChange={(event) => handleDriveSettingChange('acceleration', Number(event.target.value))}
                  />
                </label>
                <label>
                  <span>Steer Sensitivity {driveSettings.steerRate.toFixed(1)}</span>
                  <input
                    type="range"
                    min="0.6"
                    max="9"
                    step="0.1"
                    value={driveSettings.steerRate}
                    onChange={(event) => handleDriveSettingChange('steerRate', Number(event.target.value))}
                  />
                </label>
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
