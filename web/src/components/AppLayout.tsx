import ScenarioEditorPanel from '@/features/editor/ScenarioEditorPanel';
import ScenarioSidebar from '@/features/sidebar/ScenarioSidebar';
import ScenarioTimeline from '@/features/viewer/ScenarioTimeline';
import ScenarioViewer from '@/features/viewer/ScenarioViewer';
import '@/styles/app.css';

function AppLayout() {
  return (
    <div className="app-shell">
      <div className="app-body">
        <ScenarioSidebar />
        <main className="workspace-grid">
          <div className="workspace-main">
            <ScenarioViewer />
            <ScenarioTimeline />
          </div>
          <ScenarioEditorPanel />
        </main>
      </div>
    </div>
  );
}

export default AppLayout;
