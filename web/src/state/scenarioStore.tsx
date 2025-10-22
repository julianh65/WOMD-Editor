import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren
} from 'react';
import { parseScenario } from '@/lib/scenarioParser';
import { ScenarioFrame, WaymoScenario } from '@/types/scenario';

export type ScenarioSource = 'example' | 'uploaded' | 'blank';

const DEFAULT_FRAME_INTERVAL_MICROS = 100_000;

export interface ScenarioResource {
  id: string;
  name: string;
  source: ScenarioSource;
  scenario: WaymoScenario;
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
  removeScenario: (id: string) => void;
  loadScenarioFromJson: (payload: { json: unknown; name?: string; source?: ScenarioSource }) => ScenarioResource;
  createBlankScenario: (name?: string) => ScenarioResource;
  updateScenario: (id: string, updater: (current: WaymoScenario) => WaymoScenario) => void;
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
  const [showAgentLabels, setShowAgentLabels] = useState(false);

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
    setShowAgentLabels(false);

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
    setShowAgentLabels(false);

    return resource;
  }, [upsertScenario]);

  const updateScenario = useCallback<ScenarioStoreValue['updateScenario']>((id, updater) => {
    setScenarios((prev) => prev.map((resource) => {
      if (resource.id !== id) {
        return resource;
      }

      const nextScenario = updater(resource.scenario);
      return { ...resource, scenario: nextScenario };
    }));
  }, []);

  const removeScenario = useCallback<ScenarioStoreValue['removeScenario']>((id) => {
    setScenarios((prev) => prev.filter((resource) => resource.id !== id));
    setActiveScenarioId((current) => (current === id ? undefined : current));
    setVisibleTrajectoryIds(new Set());
    setIsPlaying(false);
    setShowAgentLabels(false);
  }, []);

  const activeScenario = useMemo(() => scenarios.find((resource) => resource.id === activeScenarioId)?.scenario, [scenarios, activeScenarioId]);

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
    setShowAgentLabels(false);
  }, [activeScenarioId]);

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
    removeScenario,
    loadScenarioFromJson,
    createBlankScenario,
    updateScenario
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
    removeScenario,
    loadScenarioFromJson,
    createBlankScenario,
    updateScenario
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
