import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { I18nProvider } from "./i18n/index.js";
import "./styles/fonts.js";
import "./styles/tokens.css";
import "./styles/global.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("index.html is missing its #root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
