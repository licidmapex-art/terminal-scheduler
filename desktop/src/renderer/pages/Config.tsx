import SimulationConfigForm from "../components/SimulationConfigForm";
import ErrorBoundary from "../components/ErrorBoundary";
import { PageTitleWithHelp } from "../components/HelpPopover";

export default function Config() {
  return (
    <ErrorBoundary>
      <div>
        <div className="page-header">
          <div>
            <PageTitleWithHelp
              title="Terminal configuration"
              help="Set the planning horizon, storage model, and berth spacing. Per-customer pipeline flows are configured on each customer; total storage capacity is under Resources."
            />
          </div>
        </div>

        <SimulationConfigForm />
      </div>
    </ErrorBoundary>
  );
}
