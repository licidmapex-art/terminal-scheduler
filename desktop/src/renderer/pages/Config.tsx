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
              Set the planning horizon, storage model, and berth spacing. Per-customer pipeline flows are configured on each customer; total storage capacity is under Resources.
            </p>
          </div>
        </div>

        <ScenarioManager onScenarioLoaded={() => setConfigFormKey((k) => k + 1)} />
        <SimulationConfigForm key={configFormKey} />
      </div>
    </ErrorBoundary>
  );
}
