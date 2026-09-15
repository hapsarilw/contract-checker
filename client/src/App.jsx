import { Routes, Route } from "react-router";
import LoginPage from "./pages/LoginPage.jsx";
import RegisterPage from "./pages/RegisterPage.jsx";
import UploadPage from "./pages/UploadPage.jsx";
import ReportPage from "./pages/ReportPage.jsx";
import HistoryPage from "./pages/HistoryPage.jsx";
import ComingSoonPage from "./pages/ComingSoonPage.jsx";
import NotFoundPage from "./pages/NotFoundPage.jsx";
import { RequireAuth } from "./auth/RequireAuth.jsx";
import AppHeader from "./components/AppHeader.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";

/**
 * BUILD-PLAN step 39 — the real route table, FR-7.1's all nine routes:
 * `/login`, `/register`, `/verify-email`, `/forgot-password`,
 * `/reset-password`, `/` (upload), `/documents`, `/documents/:id`,
 * `/settings`. The last four of those are placeholder routes for now
 * (ComingSoonPage) — step 63 builds what actually lives there; this
 * step's job is only to make sure the GUARD and CHROME logic is
 * correct for all nine today, so step 63 slots real pages in without
 * touching either.
 *
 * "Auth routes" (FR-7.1's own term — the five a signed-out visitor can
 * reach: login, register, and the three password/verification flows,
 * each normally arrived at from an emailed link rather than while
 * already signed in) get no `RequireAuth` and no `AppHeader` — the
 * prototype's `showAppChrome: s.screen !== 'auth'`. Every other route
 * gets both, through the small `Protected` wrapper below. `/settings`
 * is protected despite being a placeholder: the real page behind it
 * (password change, sign out everywhere, export, delete account) is
 * inherently for a signed-in user, and there is no reason for the
 * placeholder to guess otherwise.
 *
 * Every route's element is wrapped in step 31's ErrorBoundary,
 * individually — not once around the whole `<Routes>` — so a render
 * error on one screen doesn't take the app chrome (or, for an
 * unauthenticated visitor, the whole page) down with it; navigating
 * away and back gets a fresh boundary rather than a permanently tripped
 * one.
 */
function Protected({ children }) {
  return (
    <RequireAuth>
      <AppHeader />
      {children}
    </RequireAuth>
  );
}

export default function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <ErrorBoundary>
            <LoginPage />
          </ErrorBoundary>
        }
      />
      <Route
        path="/register"
        element={
          <ErrorBoundary>
            <RegisterPage />
          </ErrorBoundary>
        }
      />
      <Route
        path="/verify-email"
        element={
          <ErrorBoundary>
            <ComingSoonPage
              title="Verify your email"
              body="Email verification isn’t built yet. If you followed a link from a verification email, there’s nothing more to do here for now."
              backTo="/login"
              backLabel="Back to sign in"
            />
          </ErrorBoundary>
        }
      />
      <Route
        path="/forgot-password"
        element={
          <ErrorBoundary>
            <ComingSoonPage
              title="Forgot your password?"
              body="Password reset isn’t built yet. Nothing was sent, and no request was made."
              backTo="/login"
              backLabel="Back to sign in"
            />
          </ErrorBoundary>
        }
      />
      <Route
        path="/reset-password"
        element={
          <ErrorBoundary>
            <ComingSoonPage
              title="Reset your password"
              body="Password reset isn’t built yet. If you followed a link from a reset email, it hasn’t changed anything."
              backTo="/login"
              backLabel="Back to sign in"
            />
          </ErrorBoundary>
        }
      />
      <Route
        path="/"
        element={
          <ErrorBoundary>
            <Protected>
              <UploadPage />
            </Protected>
          </ErrorBoundary>
        }
      />
      <Route
        path="/documents"
        element={
          <ErrorBoundary>
            <Protected>
              <HistoryPage />
            </Protected>
          </ErrorBoundary>
        }
      />
      <Route
        path="/documents/:id"
        element={
          <ErrorBoundary>
            <Protected>
              <ReportPage />
            </Protected>
          </ErrorBoundary>
        }
      />
      <Route
        path="/settings"
        element={
          <ErrorBoundary>
            <Protected>
              <ComingSoonPage
                title="Settings"
                body="Password change, sign out everywhere, export, and delete account aren’t built yet."
                backTo="/"
                backLabel="Back to your contracts"
              />
            </Protected>
          </ErrorBoundary>
        }
      />
      <Route
        path="*"
        element={
          <ErrorBoundary>
            <NotFoundPage />
          </ErrorBoundary>
        }
      />
    </Routes>
  );
}
