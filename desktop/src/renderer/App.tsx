import { HashRouter, Routes, Route, NavLink } from "react-router-dom";
import { useRef } from "react";
import {
  Anchor,
  BarChart2,
  BookOpen,
  Bug,
  CalendarDays,
  ClipboardList,
  Download,
  LayoutDashboard,
  Play,
  Settings,
  Upload,
  Users,
  Warehouse
} from "lucide-react";
import Dashboard from "./pages/Dashboard";
import Schedule from "./pages/Schedule";
import Customers from "./pages/Customers";
import Resources from "./pages/Resources";
import Analytics from "./pages/Analytics";
import SimulationLog from "./pages/SimulationLog";
import ErrorBoundary from "./components/ErrorBoundary";
import Simulation from "./pages/Simulation";
import Config from "./pages/Config";
import Introduction from "./pages/Introduction";
import Debugging from "./pages/Debugging";

const NAV_ICON_SIZE = 16;

function NavIcon({ children }: { children: React.ReactNode }) {
  return <span className="nav-item-icon">{children}</span>;
}

/** Only active in the browser/web build — no-ops when Electron APIs are present. */
function useDataIO() {
  const fileRef = useRef<HTMLInputElement>(null);

  const isBrowser = typeof window !== "undefined" && !("electronAPI" in window) && typeof window.dbAPI !== "undefined";

  const handleSave = async () => {
    if (!isBrowser) return;
    try {
      const { serializeStore } = await import("../browser-api/db-api");
      const snapshot = serializeStore();
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "terminal-scheduler-data.json";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
    } catch {}
  };

  const handleLoad = () => {
    fileRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const snapshot: unknown = JSON.parse(text);
      const { hydrateStore, isValidAppSnapshot } = await import("../browser-api/db-api");
      if (!isValidAppSnapshot(snapshot)) {
        alert("Could not load file — it is not a valid Terminal Scheduler data export.");
        return;
      }
      hydrateStore(snapshot);
      window.location.reload();
    } catch {
      alert("Could not load file — make sure it is a valid Terminal Scheduler JSON export.");
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  return { isBrowser, handleSave, handleLoad, fileRef, handleFileChange };
}

export default function App() {
  const { isBrowser, handleSave, handleLoad, fileRef, handleFileChange } = useDataIO();

  return (
    <HashRouter>
      <div style={{ display: "flex", minHeight: "100vh", overflowX: "hidden", maxWidth: "100vw" }}>
        <div className="sidebar">
          <div className="sidebar-logo">
            <span className="sidebar-logo-icon">
              <Anchor size={24} strokeWidth={2.25} color="#f59e0b" />
            </span>
            <div className="sidebar-logo-text">Terminal scheduler</div>
          </div>
          <nav className="sidebar-nav">
            <div className="sidebar-section-label">Introduction</div>
            <NavLink
              to="/introduction"
              className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
            >
              <NavIcon>
                <BookOpen size={NAV_ICON_SIZE} strokeWidth={2} />
              </NavIcon>
              How scheduling works
            </NavLink>
            <div className="sidebar-section-label" style={{ marginTop: "16px" }}>
              Operations
            </div>
            <NavLink to="/" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
              <NavIcon>
                <LayoutDashboard size={NAV_ICON_SIZE} strokeWidth={2} />
              </NavIcon>
              Dashboard
            </NavLink>
            <NavLink to="/schedule" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
              <NavIcon>
                <CalendarDays size={NAV_ICON_SIZE} strokeWidth={2} />
              </NavIcon>
              Schedule
            </NavLink>
            <NavLink to="/analytics" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
              <NavIcon>
                <BarChart2 size={NAV_ICON_SIZE} strokeWidth={2} />
              </NavIcon>
              Analytics
            </NavLink>
            <NavLink to="/simulation-log" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
              <NavIcon>
                <ClipboardList size={NAV_ICON_SIZE} strokeWidth={2} />
              </NavIcon>
              Simulation Log
            </NavLink>
            <NavLink to="/debugging" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
              <NavIcon>
                <Bug size={NAV_ICON_SIZE} strokeWidth={2} />
              </NavIcon>
              Debugging
            </NavLink>
            <NavLink to="/simulation" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
              <NavIcon>
                <Play size={NAV_ICON_SIZE} strokeWidth={2} />
              </NavIcon>
              Visualization
            </NavLink>
            <div className="sidebar-section-label" style={{ marginTop: "16px" }}>Configuration</div>
            <NavLink to="/customers" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
              <NavIcon>
                <Users size={NAV_ICON_SIZE} strokeWidth={2} />
              </NavIcon>
              Customers
            </NavLink>
            <NavLink to="/resources" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
              <NavIcon>
                <Warehouse size={NAV_ICON_SIZE} strokeWidth={2} />
              </NavIcon>
              Resources
            </NavLink>
            <NavLink to="/config" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
              <NavIcon>
                <Settings size={NAV_ICON_SIZE} strokeWidth={2} />
              </NavIcon>
              Terminal
            </NavLink>
          </nav>

          {isBrowser && (
            <div style={{ padding: "12px 16px", borderTop: "1px solid #1e293b", display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "#94a3b8", marginBottom: 2 }}>Data</div>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: 12, padding: "5px 10px", width: "100%", justifyContent: "flex-start", background: "#1e293b", borderColor: "#334155", color: "#e2e8f0" }}
                onClick={handleSave}
                title="Download all customers, resources, and config as a JSON file"
              >
                <Download size={14} strokeWidth={2} />
                Save data
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: 12, padding: "5px 10px", width: "100%", justifyContent: "flex-start", background: "#1e293b", borderColor: "#334155", color: "#e2e8f0" }}
                onClick={handleLoad}
                title="Load a previously saved JSON data file"
              >
                <Upload size={14} strokeWidth={2} />
                Load data
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                style={{ display: "none" }}
                onChange={handleFileChange}
              />
            </div>
          )}
        </div>
        <main className="main-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/resources" element={<Resources />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route
              path="/simulation-log"
              element={
                <ErrorBoundary>
                  <SimulationLog />
                </ErrorBoundary>
              }
            />
            <Route path="/simulation" element={<Simulation />} />
            <Route path="/debugging" element={<Debugging />} />
            <Route path="/introduction" element={<Introduction />} />
            <Route path="/config" element={<Config />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
