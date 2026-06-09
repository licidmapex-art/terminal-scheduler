import GanttChart from "../components/GanttChart";
import ErrorBoundary from "../components/ErrorBoundary";
import { PageTitleWithHelp } from "../components/HelpPopover";

export default function Schedule() {
  return (
    <ErrorBoundary>
      <div>
        <div className="page-header">
          <div>
            <PageTitleWithHelp title="Schedule" help="Run the scheduler and view the Gantt chart" />
          </div>
        </div>
        <GanttChart />
      </div>
    </ErrorBoundary>
  );
}
