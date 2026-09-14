import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  I18nProvider,
  useI18n,
  ACTIVE_LOCALE,
  SUPPORTED_LOCALES,
} from "../../src/i18n/index.js";
import { en } from "../../src/i18n/strings/en.js";
import { id } from "../../src/i18n/strings/id.js";
import { DISCLAIMER_LOCKED } from "../../src/i18n/disclaimer.js";

const PRD_DISCLAIMER_EN =
  "ClauseCheck highlights clauses worth a second look before you sign. It isn’t a lawyer and this isn’t legal advice — for a high-stakes contract, have a professional review it.";

function Consumer() {
  const { locale, t } = useI18n();
  return (
    <p>
      {locale}: {t.copyLabel}
    </p>
  );
}

describe("i18n scaffold (BUILD-PLAN step 30, decision D-B option B1)", () => {
  it("ships English only: ACTIVE_LOCALE is en", () => {
    expect(ACTIVE_LOCALE).toBe("en");
  });

  it("both locales are supported in principle (the config the switch flips between)", () => {
    expect(SUPPORTED_LOCALES).toEqual(expect.arrayContaining(["en", "id"]));
  });

  it("useI18n() throws outside an I18nProvider — a screen can't silently render with no strings", () => {
    // Suppress the expected React error-boundary console noise for this
    // one assertion.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrow(/I18nProvider/);
    spy.mockRestore();
  });

  it("I18nProvider provides the active locale's strings to a consumer", () => {
    render(
      <I18nProvider>
        <Consumer />
      </I18nProvider>,
    );
    expect(screen.getByText(`en: ${en.copyLabel}`)).toBeInTheDocument();
  });

  it("the Indonesian string set is present and complete — every en key has an id counterpart", () => {
    const enKeys = Object.keys(en).sort();
    const idKeys = Object.keys(id).sort();
    expect(idKeys).toEqual(enKeys);
  });

  it("id strings are real Indonesian text, not English left untranslated", () => {
    expect(id.navNew).toBe("Kontrak baru");
    expect(id.copyLabel).toBe("Salin permintaan ini");
  });

  it("en.quoteNote is null (no source-language caveat needed when the UI is already English) and id.quoteNote explains it", () => {
    expect(en.quoteNote).toBeNull();
    expect(typeof id.quoteNote).toBe("string");
    expect(id.quoteNote?.length).toBeGreaterThan(0);
  });

  describe("the disclaimer (PRD §7, locked)", () => {
    it("matches PRD §7's exact wording, character for character", () => {
      expect(DISCLAIMER_LOCKED.en).toBe(PRD_DISCLAIMER_EN);
    });

    it("en.js's and id.js's disclaimer keys re-export the locked constant, not inline text", () => {
      expect(en.disclaimer).toBe(DISCLAIMER_LOCKED.en);
      expect(id.disclaimer).toBe(DISCLAIMER_LOCKED.id);
    });

    it("the locked object is frozen — an accidental mutation throws rather than silently drifting", () => {
      expect(Object.isFrozen(DISCLAIMER_LOCKED)).toBe(true);
      // Modules are already strict mode, so this throws without an
      // explicit "use strict" — assigning to a frozen object's property
      // is a TypeError there, not a silent no-op.
      expect(() => {
        // @ts-expect-error — deliberately attempting a mutation the object rejects
        DISCLAIMER_LOCKED.en = "changed";
      }).toThrow(TypeError);
    });
  });
});
