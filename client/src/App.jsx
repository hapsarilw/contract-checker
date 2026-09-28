import { Routes, Route } from "react-router";
import LoginPage from "./pages/LoginPage.jsx";
import RegisterPage from "./pages/RegisterPage.jsx";
import UploadPage from "./pages/UploadPage.jsx";
import ReportPage from "./pages/ReportPage.jsx";
import HistoryPage from "./pages/HistoryPage.jsx";
import VerifyEmailPage from "./pages/VerifyEmailPage.jsx";
import ForgotPasswordPage from "./pages/ForgotPasswordPage.jsx";
import ResetPasswordPage from "./pages/ResetPasswordPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import NotFoundPage from "./pages/NotFoundPage.jsx";
import { RequireAuth } from "./auth/RequireAuth.jsx";
import AppHeader from "./components/AppHeader.jsx";
import SkipLink from "./components/SkipLink.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";

/**
 * BUILD-PLAN step 39 — the real route table, FR-7.1's all nine routes:
 * `/login`, `/register`, `/verify-email`, `/forgot-password`,
 * `/reset-password`, `/` (upload), `/documents`, `/documents/:id`,
 * `/settings`. Step 39 built the guard and chrome logic with placeholders
 * behind four of them; step 63 slotted the real pages in (verify-email,
 * forgot-password, reset-password, settings) without touching either.
 *
 * "Auth routes" (FR-7.1's own term — the five a signed-out visitor can
 * reach: login, register, and the three password/verification flows,
 * each normally arrived at from an emailed link rather than while
 * already signed in) get no `RequireAuth` and no `AppHeader` — the
 * prototype's `showAppChrome: s.screen !== 'auth'`. Every other route
 * gets both, through the small `Protected` wrapper below. `/settings`
 * is protected: password change, sign out everywhere, export and delete
 * account are inherently for a signed-in user.
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
      {/* FIRST in the document, before the header: a skip link exists to
          get past the navigation, so it is useless placed after it. It
          used to live inside each page, which put it behind the four nav
          links on every signed-in screen (found by the step-65 audit;
          axe's own skip-link rule only checks that the target exists). */}
      <SkipLink />
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
            <VerifyEmailPage />
          </ErrorBoundary>
        }
      />
      <Route
        path="/forgot-password"
        element={
          <ErrorBoundary>
            <ForgotPasswordPage />
          </ErrorBoundary>
        }
      />
      <Route
        path="/reset-password"
        element={
          <ErrorBoundary>
            <ResetPasswordPage />
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
              <SettingsPage />
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
