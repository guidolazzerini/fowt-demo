import type { ReactNode } from "react";

/** Native disclosure works with keyboard, touch and screen readers. Keeping
 * help in document flow avoids clipped popups on the narrow control panel.
 */
export function InfoDisclosure({ label, children }: { label: string; children: ReactNode }) {
  return <details className="info-disclosure" onKeyDown={event => {
    if (event.key === "Escape") {
      event.currentTarget.open = false;
      event.currentTarget.querySelector("summary")?.focus();
      event.stopPropagation();
    }
  }}>
    <summary><span aria-hidden="true" className="info-icon">i</span>{label}</summary>
    <div className="info-content">{children}</div>
  </details>;
}
