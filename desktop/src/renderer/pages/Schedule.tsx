import GanttChart from "../components/GanttChart";
import ErrorBoundary from "../components/ErrorBoundary";

export default function Schedule() {
  return (
    <ErrorBoundary>
      <div>
        <div className="page-header">
          <div>
            <h1 className="page-title">Schedule</h1>
            <p className="page-subtitle">Run the scheduler and view the Gantt chart</p>
          </div>
        </div>
        <GanttChart />
      </div>
    </ErrorBoundary>
  );
}
