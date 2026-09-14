import { Routes, Route } from "react-router";
import LoginPage from "./pages/LoginPage.jsx";
import RegisterPage from "./pages/RegisterPage.jsx";
import UploadPage from "./pages/UploadPage.jsx";
import { RequireAuth } from "./auth/RequireAuth.jsx";

/**
 * BUILD-PLAN step 32/33 — a minimal router, just enough to prove the
 * route guard works (FR-7.1) and to give each screen built so far
 * somewhere to live. This is NOT the app shell: step 39 ("Routing,
 * guards, and the shell") replaces this file wholesale with the full
 * route table (/documents, the four placeholder routes, a 404 in the
 * prototype's visual language), the "New contract"/"History"/"Sign out"
 * app chrome, and every route wrapped in step 31's ErrorBoundary — none
 * of that exists yet, on purpose, rather than guessed at here.
 *
 * "/documents/:id" is a placeholder specifically because the real report
 * screen is steps 35-37's job; it exists only so a successful analysis
 * (step 33's UploadPage) has somewhere real to navigate to.
 */
function ReportPlaceholder() {
  return (
    <main id="main">
      <p>Analysis complete. The report screen arrives in BUILD-PLAN steps 35-37.</p>
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
        path="/documents/:id"
        element={
          <RequireAuth>
            <ReportPlaceholder />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
