import React from "react";
import ReactDOM from "react-dom/client";

import App from "@/App";
import "@/index.css";

function showFatal(message: string) {
  const node = document.createElement("pre");
  node.style.cssText =
    "margin:0;padding:16px;font:12px/1.5 monospace;white-space:pre-wrap;color:#b91c1c;background:#fff";
  node.textContent = `Failed to start:\n\n${message}`;
  document.body.innerHTML = "";
  document.body.appendChild(node);
}

window.addEventListener("error", (event) => {
  if (!document.getElementById("root")?.hasChildNodes()) {
    const detail = event.error instanceof Error ? (event.error.stack ?? event.message) : event.message;
    showFatal(detail || String(event.error));
  }
});

try {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} catch (error) {
  showFatal(error instanceof Error ? (error.stack ?? error.message) : String(error));
}
