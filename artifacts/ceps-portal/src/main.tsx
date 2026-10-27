import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installBrowserTranslationGuard } from "./lib/browser-translation";

// Browser translators replace React text nodes: https://github.com/facebook/react/issues/11538
installBrowserTranslationGuard();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
