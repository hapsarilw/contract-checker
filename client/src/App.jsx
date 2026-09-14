/**
 * BUILD-PLAN step 29 — this is a tokens sanity check, not a screen. The
 * step's own instruction is explicit: "Do not build any screens yet."
 * Route components (upload, analyzing, report, history, auth, settings)
 * arrive in later UI-* steps. This file exists only so the step's own
 * verification — "a page rendering only the token palette matches the
 * prototype's colours" — has something to render, and gets replaced
 * wholesale once real routes exist.
 */

const PALETTE = [
  { name: "brand", token: "--cc-brand", hex: "#1F4740" },
  { name: "brand-hover", token: "--cc-brand-hover", hex: "#16302B" },
  { name: "surface-card", token: "--cc-surface-card", hex: "#FBFAF6" },
  { name: "surface-page", token: "--cc-surface-page", hex: "#E2E2DA" },
  { name: "surface-muted", token: "--cc-surface-muted", hex: "#F2F1E9" },
  { name: "ink", token: "--cc-ink", hex: "#1D2422" },
  { name: "ink-secondary", token: "--cc-ink-secondary", hex: "#525955" },
  { name: "ink-muted", token: "--cc-ink-muted", hex: "#7F857D" },
  { name: "ink-on-muted", token: "--cc-ink-on-muted", hex: "#575E5A" },
  { name: "rule", token: "--cc-rule", hex: "#D5D2C6" },
  { name: "rule-strong", token: "--cc-rule-strong", hex: "#C7C4B6" },
  { name: "rule-soft", token: "--cc-rule-soft", hex: "#E9E6DC" },
  { name: "placeholder", token: "--cc-placeholder", hex: "#9DA39B" },
  { name: "severity-high", token: "--cc-severity-high", hex: "#7A3F2E" },
  { name: "severity-medium", token: "--cc-severity-medium", hex: "#7A6520" },
  { name: "severity-low", token: "--cc-severity-low", hex: "#3D5A4E" },
];

function Swatch({ name, token, hex }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--cc-space-5)" }}>
      <span
        aria-hidden="true"
        style={{
          display: "block",
          width: 44,
          height: 44,
          flexShrink: 0,
          background: `var(${token})`,
          border: "var(--cc-border-width) solid var(--cc-rule)",
        }}
      />
      <span style={{ fontFamily: "var(--cc-font-mono)", fontSize: "var(--cc-text-xs)" }}>
        {token}
        <br />
        <span style={{ color: "var(--cc-ink-secondary)" }}>
          {name} · {hex}
        </span>
      </span>
    </div>
  );
}

export default function App() {
  return (
    <main
      style={{
        maxWidth: 620,
        margin: "0 auto",
        padding: "var(--cc-space-11) var(--cc-space-8)",
      }}
    >
      <h1
        style={{
          fontFamily: "var(--cc-font-serif)",
          fontSize: "var(--cc-text-2xl)",
          letterSpacing: "var(--cc-tracking-tight)",
          margin: "0 0 var(--cc-space-2)",
        }}
      >
        ClauseCheck design tokens
      </h1>
      <p
        style={{
          fontSize: "var(--cc-text-base)",
          color: "var(--cc-ink-secondary)",
          lineHeight: "var(--cc-leading-normal)",
          margin: "0 0 var(--cc-space-9)",
        }}
      >
        Step 29 (UI-1) sanity check — every swatch below is a CSS custom property from{" "}
        <code>src/styles/tokens.css</code>, rendered against its source hex from the
        design prototype.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: "var(--cc-space-6)",
        }}
      >
        {PALETTE.map((swatch) => (
          <Swatch key={swatch.token} {...swatch} />
        ))}
      </div>
    </main>
  );
}
