import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import Library from "./pages/Library";
import Analysis from "./pages/Analysis";
import { toggleTheme, useTheme } from "./theme";

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z" />
    </svg>
  );
}

export default function App() {
  const loc = useLocation();
  const theme = useTheme();
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span>Gauge.S</span> Track Analyzer
        </div>
        <div className="topbar-end">
          <div id="analysis-header-slot" className="analysis-header-slot" />
          <button
            className="theme-toggle"
            type="button"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={toggleTheme}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <nav className="tabs">
            <Link className={loc.pathname === "/" ? "active" : ""} to="/">
              Library
            </Link>
            <Link className={loc.pathname.startsWith("/analyze") ? "active" : ""} to="/analyze">
              Analysis
            </Link>
          </nav>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/analyze" element={<Analysis />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
