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

export function buildScenarioExportPayload(scenario: WaymoScenario): ScenarioExportPayload {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    metadata: { ...scenario.metadata },
    bounds: scenario.bounds ? { ...scenario.bounds } : undefined,
    agents: cloneAgents(scenario.agents),
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

  const payload = buildScenarioExportPayload(scenario);
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
