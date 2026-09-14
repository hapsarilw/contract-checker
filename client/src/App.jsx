import { Routes, Route } from "react-router";
import LoginPage from "./pages/LoginPage.jsx";
import RegisterPage from "./pages/RegisterPage.jsx";
import UploadPage from "./pages/UploadPage.jsx";
import ReportPage from "./pages/ReportPage.jsx";
import HistoryPage from "./pages/HistoryPage.jsx";
import { RequireAuth } from "./auth/RequireAuth.jsx";

/**
 * BUILD-PLAN step 32/33/35/37/38 — a minimal router, just enough to
 * prove the route guard works (FR-7.1) and to give each screen built so
 * far somewhere to live. This is NOT the app shell: step 39 ("Routing,
 * guards, and the shell") replaces this file wholesale with the full
 * route table, the "New contract"/"History"/"Sign out" app chrome, and
 * every route wrapped in step 31's ErrorBoundary — none of that exists
 * yet, on purpose, rather than guessed at here.
 *
 * "/documents/:id" renders the real ReportPage (steps 35-37 build it
 * across three steps; step 35 is the top of it — see ReportPage.jsx).
 * "/documents" now renders the real HistoryPage (step 38) — step 37 had
 * only wired the route (FR-7.6's delete redirect needed somewhere real
 * to land before this step built what's actually there).
 */
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
            <HistoryPage />
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
