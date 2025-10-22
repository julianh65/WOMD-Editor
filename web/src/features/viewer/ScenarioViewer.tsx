import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useScenarioStore } from '@/state/scenarioStore';
import { RoadEdge, ScenarioAgent, ScenarioBounds, ScenarioFrameAgentState } from '@/types/scenario';

type CameraState = {
  zoom: number;
  panX: number;
  panY: number;
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

interface BaseTransformContext {
  transform: CanvasTransform;
  width: number;
  height: number;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;

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

const DEFAULT_AGENT_DIMENSIONS: Record<string, { length: number; width: number }> = {
  VEHICLE: { length: 4.5, width: 2.0 },
  PEDESTRIAN: { length: 0.8, width: 0.8 },
  CYCLIST: { length: 1.8, width: 0.6 },
  OTHER: { length: 2.0, width: 1.0 }
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

  const zoomedX = (anchor.x - centerX) * camera.zoom + centerX + camera.panX;
  const zoomedY = (anchor.y - centerY) * camera.zoom + centerY + camera.panY;

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

  const anchorX = ((canvasX - centerX - camera.panX) / camera.zoom) + centerX;
  const anchorY = ((canvasY - centerY - camera.panY) / camera.zoom) + centerY;

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
  dims: CanvasDims
) {
  if (!agent.trajectory.length) {
    return;
  }

  ctx.save();
  ctx.strokeStyle = getTrajectoryColour(agent);
  ctx.lineWidth = 2.25;
  ctx.setLineDash([]);

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

function drawAgent(
  ctx: CanvasRenderingContext2D,
  agentState: ScenarioFrameAgentState,
  base: CanvasTransform,
  camera: CameraState,
  dims: CanvasDims,
  agentInfo?: ScenarioAgent,
  showLabel?: boolean
) {
  const fallbackDims = DEFAULT_AGENT_DIMENSIONS[agentState.type] ?? DEFAULT_AGENT_DIMENSIONS.OTHER;
  const dimensions = agentInfo?.dimensions ?? fallbackDims;

  const lengthMeters = agentState.length ?? dimensions.length ?? fallbackDims.length;
  const widthMeters = agentState.width ?? dimensions.width ?? fallbackDims.width;

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
    activeFrame,
    activeFrameIndex,
    visibleTrajectoryIds,
    showAgentLabels
  } = useScenarioStore();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseTransformRef = useRef<BaseTransformContext | null>(null);
  const dragStateRef = useRef<{ active: boolean; pointerId: number | null; lastX: number; lastY: number }>({
    active: false,
    pointerId: null,
    lastX: 0,
    lastY: 0
  });

  const [camera, setCamera] = useState<CameraState>({ zoom: 1, panX: 0, panY: 0 });
  const [isDragging, setIsDragging] = useState(false);

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
    if (!activeScenario || visibleTrajectoryIds.size === 0) {
      return [] as ScenarioAgent[];
    }

    return activeScenario.agents.filter((agent) => visibleTrajectoryIds.has(agent.id));
  }, [activeScenario, visibleTrajectoryIds]);

  useEffect(() => {
    setCamera({ zoom: 1, panX: 0, panY: 0 });
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
      drawTrajectory(ctx, agent, baseTransform, camera, dims);
    });

    activeFrame.agents.forEach((agentState) => {
      const agentInfo = agentById.get(agentState.id);
      drawAgent(ctx, agentState, baseTransform, camera, dims, agentInfo, showAgentLabels);
    });
  }, [activeScenario, activeFrame, activeFrameIndex, trajectoryAgents, agentById, camera]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    canvas.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      active: true,
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY
    };
    setIsDragging(true);
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = dragStateRef.current;
    if (!state.active || state.pointerId !== event.pointerId) {
      return;
    }

    const dx = event.clientX - state.lastX;
    const dy = event.clientY - state.lastY;
    state.lastX = event.clientX;
    state.lastY = event.clientY;

    setCamera((prev) => ({
      zoom: prev.zoom,
      panX: prev.panX + dx,
      panY: prev.panY + dy
    }));
  }, []);

  const stopDragging = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (canvas && canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }

    dragStateRef.current = {
      active: false,
      pointerId: null,
      lastX: 0,
      lastY: 0
    };
    setIsDragging(false);
  }, []);

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
          panY
        };
      });
    },
    []
  );

  const stageClassName = isDragging ? 'viewer__stage viewer__stage--dragging' : 'viewer__stage';

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
          onPointerUp={stopDragging}
          onPointerLeave={stopDragging}
          onPointerCancel={stopDragging}
          onWheel={handleWheel}
        />
        {!activeFrame && <p className="viewer__overlay">Load or create a scenario to start exploring the scene.</p>}
      </div>
    </section>
  );
}

export default ScenarioViewer;
