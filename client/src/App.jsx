import { Routes, Route } from "react-router";
import LoginPage from "./pages/LoginPage.jsx";
import RegisterPage from "./pages/RegisterPage.jsx";
import UploadPage from "./pages/UploadPage.jsx";
import ReportPage from "./pages/ReportPage.jsx";
import { RequireAuth } from "./auth/RequireAuth.jsx";

/**
 * BUILD-PLAN step 32/33/35/37 — a minimal router, just enough to prove
 * the route guard works (FR-7.1) and to give each screen built so far
 * somewhere to live. This is NOT the app shell: step 39 ("Routing,
 * guards, and the shell") replaces this file wholesale with the full
 * route table, the "New contract"/"History"/"Sign out" app chrome, and
 * every route wrapped in step 31's ErrorBoundary — none of that exists
 * yet, on purpose, rather than guessed at here.
 *
 * "/documents/:id" now renders the real ReportPage (steps 35-37 build it
 * across three steps; step 35 is the top of it — see ReportPage.jsx).
 *
 * "/documents" is a placeholder for the same reason step 33 left
 * "/documents/:id" as one before step 35 built the real thing: FR-7.6's
 * delete flow (step 37, ReportPage.jsx's handleConfirmDelete) redirects
 * here, and needs somewhere real — not "/" — to land. Step 38 replaces
 * it with the real history list.
 */
function HistoryPlaceholder() {
  return (
    <main id="main">
      <p>Document deleted. The history screen arrives in BUILD-PLAN step 38.</p>
    </main>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <UploadPage />
          </RequireAuth>
        }
      />
      <Route
        path="/documents"
        element={
          <RequireAuth>
            <HistoryPlaceholder />
          </RequireAuth>
        }
      />
      <Route
        path="/documents/:id"
        element={
          <RequireAuth>
            <ReportPage />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
