// Lightweight, dependency-free hover/focus tooltip for the hand-rolled charts.
// Renders through a portal to <body> with fixed positioning so it escapes the
// `overflow: hidden` on .card — a tooltip anchored inside a chart would
// otherwise be clipped at the card edge. The visual tooltip is an enhancement
// for sighted users; every chart element it attaches to also carries its own
// aria-label / role so assistive tech and no-JS hover (title) get the same info.

import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface TipState {
  content: ReactNode;
  x: number;
  y: number;
}

export interface ChartTooltipApi {
  tip: TipState | null;
  /** Spread onto a chart element to show `content` on hover and keyboard focus. */
  bind: (content: ReactNode) => {
    onMouseEnter: (e: { clientX: number; clientY: number }) => void;
    onMouseMove: (e: { clientX: number; clientY: number }) => void;
    onMouseLeave: () => void;
    onFocus: (e: { currentTarget: { getBoundingClientRect: () => DOMRect } }) => void;
    onBlur: () => void;
  };
  hide: () => void;
}

export function useChartTooltip(): ChartTooltipApi {
  const [tip, setTip] = useState<TipState | null>(null);

  const place = (content: ReactNode, clientX: number, clientY: number) => {
    // Keep the (center-anchored) tooltip clear of the viewport edges.
    const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
    const x = Math.min(Math.max(clientX, 120), vw - 120);
    setTip({ content, x, y: clientY });
  };

  const hide = () => setTip(null);

  const bind = (content: ReactNode) => ({
    onMouseEnter: (e: { clientX: number; clientY: number }) => place(content, e.clientX, e.clientY),
    onMouseMove: (e: { clientX: number; clientY: number }) => place(content, e.clientX, e.clientY),
    onMouseLeave: hide,
    onFocus: (e: { currentTarget: { getBoundingClientRect: () => DOMRect } }) => {
      const r = e.currentTarget.getBoundingClientRect();
      place(content, r.left + r.width / 2, r.top);
    },
    onBlur: hide,
  });

  return { tip, bind, hide };
}

export function ChartTooltip({ tip }: { tip: TipState | null }) {
  if (!tip) return null;
  // Flip below the cursor when near the top of the viewport so it never clips.
  const below = tip.y < 96;
  return createPortal(
    <div className={`chart-tip${below ? " below" : ""}`} style={{ left: tip.x, top: tip.y }} aria-hidden="true">
      {tip.content}
    </div>,
    document.body,
  );
}
