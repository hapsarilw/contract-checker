import { Routes, Route } from "react-router";
import LoginPage from "./pages/LoginPage.jsx";
import RegisterPage from "./pages/RegisterPage.jsx";
import { RequireAuth } from "./auth/RequireAuth.jsx";

/**
 * BUILD-PLAN step 32 — a minimal router, just enough to prove the route
 * guard works (FR-7.1) and to give /login and /register somewhere to
 * live. This is NOT the app shell: step 39 ("Routing, guards, and the
 * shell") replaces this file wholesale with the full route table
 * (/documents, /documents/:id, the four placeholder routes, a 404 in the
 * prototype's visual language), the "New contract"/"History"/"Sign out"
 * app chrome, and every route wrapped in step 31's ErrorBoundary — none
 * of that exists yet, on purpose, rather than guessed at here.
 *
 * "/" is a placeholder specifically because the real upload screen is
 * step 33's job; it exists only so RequireAuth has a protected route to
 * guard for this step's own verification ("Unauthenticated access to /
 * redirects to /login").
 */
function UploadPlaceholder() {
  return (
    <main id="main">
      <p>Signed in. The upload screen arrives in BUILD-PLAN step 33.</p>
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
            <UploadPlaceholder />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
