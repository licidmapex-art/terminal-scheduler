import { useState } from "react";
import SimulationConfigForm from "../components/SimulationConfigForm";
import ScenarioManager from "../components/ScenarioManager";
import ErrorBoundary from "../components/ErrorBoundary";

export default function Config() {
  const [configFormKey, setConfigFormKey] = useState(0);

  return (
    <ErrorBoundary>
      <div>
        <div className="page-header">
          <div>
            <h1 className="page-title">Terminal configuration</h1>
            <p className="page-subtitle">
              Set the planning horizon, whether pipeline flow fills or drains tanks (rates are on each customer),
              storage mode, and berth spacing.
            </p>
          </div>
        </div>

        <ScenarioManager onScenarioLoaded={() => setConfigFormKey((k) => k + 1)} />
        <SimulationConfigForm key={configFormKey} />
      </div>
    </ErrorBoundary>
  );
}
