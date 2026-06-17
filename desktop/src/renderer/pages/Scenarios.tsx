import ScenarioManager from "../components/ScenarioManager";
import ErrorBoundary from "../components/ErrorBoundary";
import { PageTitleWithHelp } from "../components/HelpPopover";

export default function Scenarios() {
  return (
    <ErrorBoundary>
      <div>
        <div className="page-header">
          <div>
            <PageTitleWithHelp
              title="Scenarios"
              help="Save and load named snapshots of customers, resources, and terminal configuration. Loading replaces the current setup and clears scheduled slots — run the scheduler again on the Schedule tab after loading."
            />
          </div>
        </div>

        <ScenarioManager hideHeader />
      </div>
    </ErrorBoundary>
  );
}
