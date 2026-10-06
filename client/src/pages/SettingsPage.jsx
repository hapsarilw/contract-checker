import { useAuth } from "../auth/useAuth.js";
import ChangeEmailSection from "./settings/ChangeEmailSection.jsx";
import ChangePasswordSection from "./settings/ChangePasswordSection.jsx";
import DeleteAccountSection from "./settings/DeleteAccountSection.jsx";
import ExportSection from "./settings/ExportSection.jsx";
import SignOutEverywhereSection from "./settings/SignOutEverywhereSection.jsx";
import "./SettingsPage.css";

/**
 * FR-7.1's /settings: change password, change email (FR-1.13, step 75),
 * sign out everywhere, download my data, delete my account. Rendered inside the app chrome by App.jsx's
 * `Protected`, so the header and the auth guard are not this file's
 * business.
 *
 * ORDER IS DELIBERATE. The routine, reversible things come first and the
 * destructive one comes last, set apart, so the last thing on the page is
 * not something a scrolling thumb can land on by accident.
 *
 * One `<h1>`, then one `<h2>` per section (SRS §7.15), each section its
 * own labelled region.
 */
export default function SettingsPage() {
  const { user } = useAuth();

  return (
    <div className="cc-settings">
      <main id="main" tabIndex={-1}>
        <h1 className="cc-settings__title">Settings</h1>
        <p className="cc-settings__account">
          Signed in as <strong>{user?.email}</strong>
        </p>

        <ChangePasswordSection />
        <ChangeEmailSection />
        <SignOutEverywhereSection />
        <ExportSection />
        <DeleteAccountSection />
      </main>
    </div>
  );
}
