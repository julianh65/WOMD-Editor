import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { useScenarioStore } from '@/state/scenarioStore';

function ScenarioEditorPanel() {
  const {
    activeScenario,
    activeScenarioId,
    updateScenario,
    visibleTrajectoryIds,
    toggleTrajectoryVisibility,
    showAllTrajectories,
    hideAllTrajectories,
    showAgentLabels,
    toggleAgentLabels
  } = useScenarioStore();
  const [localName, setLocalName] = useState('');

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

    updateScenario(activeScenarioId, (current) => ({
      ...current,
      metadata: {
        ...current.metadata,
        name: nextName
      }
    }));
  }, [activeScenario, activeScenarioId, localName, updateScenario]);

  const handleExport = useCallback(() => {
    if (!activeScenario) {
      return;
    }

    const blob = new Blob([JSON.stringify(activeScenario.raw ?? activeScenario, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${activeScenario.metadata.name || 'scenario'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [activeScenario]);

  const agents = useMemo(() => activeScenario?.agents ?? [], [activeScenario?.agents]);
  const allVisible = useMemo(() => {
    if (!activeScenario) {
      return false;
    }
    if (activeScenario.agents.length === 0) {
      return false;
    }
    return activeScenario.agents.every((agent) => visibleTrajectoryIds.has(agent.id));
  }, [activeScenario, visibleTrajectoryIds]);

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
        <button type="button" className="button" onClick={handleExport}>
          Export JSON
        </button>
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
            <button type="button" className="button button--secondary" onClick={allVisible ? hideAllTrajectories : showAllTrajectories}>
              {allVisible ? 'Hide All' : 'Show All'}
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
              return (
                <li key={agent.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={isVisible}
                      onChange={() => toggleTrajectoryVisibility(agent.id)}
                    />
                    <span>{label}{badge}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="editor-panel__placeholder">
        <p>The interactive editor for agents, trajectories, and road edges will live here.</p>
      </div>
    </section>
  );
}

export default ScenarioEditorPanel;
