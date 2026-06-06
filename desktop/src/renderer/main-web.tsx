// Browser entry point: inject in-memory API shims before mounting React.
import "../browser-api/index";

import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/global.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
