import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { useScenarioStore } from '@/state/scenarioStore';

function ScenarioEditorPanel() {
  const {
    activeScenario,
    activeScenarioId,
    updateScenario,
    updateAgentStartPose,
    visibleTrajectoryIds,
    toggleTrajectoryVisibility,
    showAllTrajectories,
    hideAllTrajectories,
    showAgentLabels,
    toggleAgentLabels,
    toggleAgentExpert,
    removeAllAgents,
    spawnVehicleAgent,
    editing
  } = useScenarioStore();
  const {
    state: editingState,
    selectEntity,
    clearSelection,
    pushHistoryEntry,
    undo,
    redo,
    canUndo,
    canRedo
  } = editing;
  const [localName, setLocalName] = useState('');
  const [startPoseDraft, setStartPoseDraft] = useState({ x: '', y: '', heading: '' });

  useEffect(() => {
    setLocalName(activeScenario?.metadata.name ?? '');
  }, [activeScenario?.metadata.name]);

  const handleNameChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setLocalName(event.target.value);
  }, []);

  const handleNameCommit = useCallback(() => {
    if (!activeScenario || !activeScenarioId) {
      return;
    }

    const nextName = localName.trim();
    if (!nextName) {
      return;
    }

    const previousName = activeScenario.metadata.name;
    if (previousName === nextName) {
      return;
    }

    updateScenario(activeScenarioId, (current) => ({
      ...current,
      metadata: {
        ...current.metadata,
        name: nextName
      }
    }));

    const now = Date.now();
    pushHistoryEntry({
      id: `rename-${now.toString(36)}`,
      label: `Renamed scenario to ${nextName}`,
      timestamp: now
    });
  }, [activeScenario, activeScenarioId, localName, updateScenario, pushHistoryEntry]);

  const handleUndo = useCallback(() => {
    undo();
  }, [undo]);

  const handleRedo = useCallback(() => {
    redo();
  }, [redo]);

  const handleExport = useCallback(() => {
    if (!activeScenario) {
      return;
    }

    const { raw: _raw, ...exportableScenario } = activeScenario;
    const blob = new Blob([JSON.stringify(exportableScenario, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${activeScenario.metadata.name || 'scenario'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [activeScenario]);

  const selectedEntity = editingState.selectedEntity;
  const selectedAgentId = selectedEntity?.kind === 'agent' ? selectedEntity.id : undefined;
  const agents = useMemo(() => activeScenario?.agents ?? [], [activeScenario?.agents]);
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId),
    [agents, selectedAgentId]
  );

  useEffect(() => {
    if (!selectedAgent) {
      setStartPoseDraft({ x: '', y: '', heading: '' });
      return;
    }

    const anchorPoint = selectedAgent.trajectory.find((point) => point.valid !== false) ?? selectedAgent.trajectory[0];
    if (!anchorPoint) {
      setStartPoseDraft({ x: '', y: '', heading: '' });
      return;
    }

    const headingDeg = typeof anchorPoint.heading === 'number'
      ? (anchorPoint.heading * 180) / Math.PI
      : 0;

    setStartPoseDraft({
      x: anchorPoint.x.toFixed(2),
      y: anchorPoint.y.toFixed(2),
      heading: headingDeg.toFixed(1)
    });
  }, [selectedAgent]);
  const allVisible = useMemo(() => {
    if (!activeScenario) {
      return false;
    }
    if (activeScenario.agents.length === 0) {
      return false;
    }
    return activeScenario.agents.every((agent) => visibleTrajectoryIds.has(agent.id));
  }, [activeScenario, visibleTrajectoryIds]);

  const handleAgentSelect = useCallback((agentId: string) => {
    if (selectedAgentId === agentId) {
      clearSelection();
      return;
    }

    selectEntity({ kind: 'agent', id: agentId });
  }, [selectedAgentId, clearSelection, selectEntity]);

  const handleClearSelection = useCallback(() => {
    clearSelection();
  }, [clearSelection]);

  const handleStartPoseChange = useCallback((field: 'x' | 'y' | 'heading', value: string) => {
    setStartPoseDraft((prev) => ({ ...prev, [field]: value }));
  }, []);

  const handleDeleteAllAgents = useCallback(() => {
    if (!activeScenario || !activeScenarioId || activeScenario.agents.length === 0) {
      return;
    }

    const confirmed = window.confirm('Delete all agents from this scenario? This cannot be undone.');
    if (!confirmed) {
      return;
    }

    const removed = removeAllAgents(activeScenarioId);
    if (removed) {
      clearSelection();
      const now = Date.now();
      pushHistoryEntry({
        id: `delete-all-${now.toString(36)}`,
        label: 'Removed all agents',
        timestamp: now
      });
    }
  }, [activeScenario, activeScenarioId, removeAllAgents, clearSelection, pushHistoryEntry]);

  const handleSpawnVehicle = useCallback(() => {
    if (!activeScenarioId) {
      return;
    }

    const spawned = spawnVehicleAgent(activeScenarioId);
    if (!spawned) {
      return;
    }

    selectEntity({ kind: 'agent', id: spawned.id });
    const now = Date.now();
    pushHistoryEntry({
      id: `spawn-${spawned.id}-${now.toString(36)}`,
      label: `Spawned ${spawned.displayName ?? spawned.id}`,
      timestamp: now
    });
  }, [activeScenarioId, spawnVehicleAgent, selectEntity, pushHistoryEntry]);

  const commitStartPose = useCallback(() => {
    if (!activeScenario || !activeScenarioId || !selectedAgent) {
      return;
    }

    const anchorPoint = selectedAgent.trajectory.find((point) => point.valid !== false) ?? selectedAgent.trajectory[0];
    if (!anchorPoint) {
      return;
    }

    const parsedX = Number.parseFloat(startPoseDraft.x);
    const parsedY = Number.parseFloat(startPoseDraft.y);
    const parsedHeading = Number.parseFloat(startPoseDraft.heading);

    const nextX = Number.isFinite(parsedX) ? parsedX : anchorPoint.x;
    const nextY = Number.isFinite(parsedY) ? parsedY : anchorPoint.y;
    const anchorHeadingDeg = typeof anchorPoint.heading === 'number' ? (anchorPoint.heading * 180) / Math.PI : 0;
    const nextHeadingDeg = Number.isFinite(parsedHeading) ? parsedHeading : anchorHeadingDeg;
    const nextHeadingRad = (nextHeadingDeg * Math.PI) / 180;

    const epsilon = 1e-4;
    const unchanged =
      Math.abs(nextX - anchorPoint.x) < epsilon &&
      Math.abs(nextY - anchorPoint.y) < epsilon &&
      Math.abs(nextHeadingRad - (anchorPoint.heading ?? 0)) < epsilon;

    if (unchanged) {
      return;
    }

    updateAgentStartPose(activeScenarioId, selectedAgent.id, {
      x: nextX,
      y: nextY,
      headingRadians: nextHeadingRad
    });

    const now = Date.now();
    pushHistoryEntry({
      id: `pose-${selectedAgent.id}-${now.toString(36)}`,
      label: `Adjusted ${selectedAgent.displayName ?? selectedAgent.id} start pose`,
      timestamp: now
    });
  }, [
    activeScenario,
    activeScenarioId,
    selectedAgent,
    startPoseDraft.x,
    startPoseDraft.y,
    startPoseDraft.heading,
    updateAgentStartPose,
    pushHistoryEntry
  ]);

  const handleToggleExpert = useCallback(() => {
    if (!activeScenarioId || !selectedAgent) {
      return;
    }

    const nextIsExpert = !selectedAgent.isExpert;
    const updated = toggleAgentExpert(activeScenarioId, selectedAgent.id);
    if (updated) {
      const now = Date.now();
      pushHistoryEntry({
        id: `expert-${selectedAgent.id}-${now.toString(36)}`,
        label: nextIsExpert
          ? `Marked ${selectedAgent.displayName ?? selectedAgent.id} as expert`
          : `Unmarked ${selectedAgent.displayName ?? selectedAgent.id} as expert`,
        timestamp: now
      });
    }
  }, [activeScenarioId, selectedAgent, toggleAgentExpert, pushHistoryEntry]);

  const handleStartPoseKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitStartPose();
    }
  }, [commitStartPose]);

  if (!activeScenario) {
    return (
      <section className="editor-panel editor-panel--empty">
        <p>Select or create a scenario to edit metadata, agents, lanes, and trajectories.</p>
      </section>
    );
  }

  return (
    <section className="editor-panel">
      <div className="editor-panel__header">
        <h3>Scenario Details</h3>
        <div className="editor-panel__header-actions">
          <button
            type="button"
            className="button button--secondary"
            onClick={handleUndo}
            disabled={!canUndo}
            title="Undo is still a work in progress"
          >
            Undo (doesn't work yet)
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={handleRedo}
            disabled={!canRedo}
            title="Redo is still a work in progress"
          >
            Redo (doesn't work yet)
          </button>
          <button
            type="button"
            className="button"
            onClick={handleExport}
            title="Export is still a work in progress"
          >
            Export JSON (doesn't work yet)
          </button>
        </div>
      </div>

      <div className="editor-panel__controls">
        <label>
          Scenario Name
          <div className="field-row">
            <input
              type="text"
              placeholder="Scenario name"
              value={localName}
              onChange={handleNameChange}
            />
            <button type="button" className="button button--secondary" onClick={handleNameCommit}>
              Save
            </button>
          </div>
        </label>
        <label className="toggle-row">
          <span>Show Agent Labels</span>
          <input
            type="checkbox"
            checked={showAgentLabels}
            onChange={() => toggleAgentLabels()}
          />
        </label>
      </div>

      <div className="editor-panel__section">
        <div className="editor-panel__section-header">
          <h4>Agent Trajectories</h4>
          <div className="editor-panel__section-actions">
            <button type="button" className="button button--primary" onClick={handleSpawnVehicle}>
              Spawn Vehicle
            </button>
            <button type="button" className="button button--secondary" onClick={allVisible ? hideAllTrajectories : showAllTrajectories}>
              {allVisible ? 'Hide All' : 'Show All'}
            </button>
            <button type="button" className="button button--danger" onClick={handleDeleteAllAgents}>
              Delete All
            </button>
          </div>
        </div>
        {agents.length === 0 ? (
          <p className="editor-panel__placeholder">No agents loaded for this scenario.</p>
        ) : (
          <ul className="trajectory-list">
            {agents.map((agent) => {
              const isVisible = visibleTrajectoryIds.has(agent.id);
              const label = agent.displayName || agent.id;
              const badge = agent.isExpert ? ' (expert)' : '';
              const isSelected = selectedAgentId === agent.id;
              return (
                <li key={agent.id} className={isSelected ? 'trajectory-list__item trajectory-list__item--selected' : 'trajectory-list__item'}>
                  <div className="trajectory-list__item-row">
                    <label>
                      <input
                        type="checkbox"
                        checked={isVisible}
                        onChange={() => toggleTrajectoryVisibility(agent.id)}
                      />
                      <span>{label}{badge}</span>
                    </label>
                    <button
                      type="button"
                      className="button button--secondary"
                      aria-pressed={isSelected}
                      onClick={() => handleAgentSelect(agent.id)}
                    >
                      {isSelected ? 'Selected' : 'Select'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="editor-panel__section">
        <div className="editor-panel__section-header">
          <h4>Selection</h4>
          {selectedEntity && (
            <button type="button" className="button button--secondary" onClick={handleClearSelection}>
              Clear Selection
            </button>
          )}
        </div>
        {selectedAgent ? (
          <>
            <ul className="selection-summary">
              <li>
                <span>ID</span>
                <code>{selectedAgent.id}</code>
              </li>
              <li>
                <span>Type</span>
                <span>{selectedAgent.type}</span>
              </li>
              <li>
                <span>Trajectory Points</span>
                <span>{selectedAgent.trajectory.length}</span>
              </li>
              <li>
                <span>Expert</span>
                <span>{selectedAgent.isExpert ? 'Yes' : 'No'}</span>
              </li>
            </ul>
            <label className="toggle-row">
              <span>Mark as Expert</span>
              <input
                type="checkbox"
                checked={Boolean(selectedAgent.isExpert)}
                onChange={handleToggleExpert}
              />
            </label>
            <div className="selection-edit-grid">
              <label>
                Start X (m)
                <input
                  type="number"
                  step="0.05"
                  value={startPoseDraft.x}
                  onChange={(event) => handleStartPoseChange('x', event.target.value)}
                  onBlur={commitStartPose}
                  onKeyDown={handleStartPoseKeyDown}
                  placeholder="0.00"
                />
              </label>
              <label>
                Start Y (m)
                <input
                  type="number"
                  step="0.05"
                  value={startPoseDraft.y}
                  onChange={(event) => handleStartPoseChange('y', event.target.value)}
                  onBlur={commitStartPose}
                  onKeyDown={handleStartPoseKeyDown}
                  placeholder="0.00"
                />
              </label>
              <label>
                Start Heading (deg)
                <input
                  type="number"
                  step="1"
                  value={startPoseDraft.heading}
                  onChange={(event) => handleStartPoseChange('heading', event.target.value)}
                  onBlur={commitStartPose}
                  onKeyDown={handleStartPoseKeyDown}
                  placeholder="0"
                />
              </label>
            </div>
            <button type="button" className="button button--secondary" onClick={commitStartPose}>
              Apply Start Pose
            </button>
          </>
        ) : (
          <p className="editor-panel__placeholder">Select an agent to edit trajectory details.</p>
        )}
      </div>
    </section>
  );
}

export default ScenarioEditorPanel;
