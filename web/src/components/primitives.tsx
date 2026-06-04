import type { ReactNode } from "react";

// Core layout primitives — React ports of card()/metric()/pageHeader() from
// src/dashboard/layout.ts.

export function Card(props: {
  title?: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  tone?: "accent" | "good" | "danger";
  bodyClass?: "flush" | "tight" | "chart";
  id?: string;
}) {
  const toneCls = props.tone ? ` tone-${props.tone}` : "";
  const bodyCls = props.bodyClass ? ` ${props.bodyClass}` : "";
  const hasHead = props.title || props.subtitle || props.right;
  return (
    <section className={`card${toneCls}`} id={props.id}>
      {hasHead ? (
        <div className="card-head">
          {props.title ? <h2>{props.title}</h2> : <span />}
          <div className="card-sub">
            {props.subtitle}
            {props.right ? (
              <>
                {props.subtitle ? " " : ""}
                {props.right}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className={`card-body${bodyCls}`}>{props.children}</div>
    </section>
  );
}

export function Metric(props: {
  label: ReactNode;
  value: string | number;
  tone?: "good" | "danger" | "neutral";
  hero?: boolean;
  foot?: ReactNode;
}) {
  const valueCls = props.tone === "danger" ? " danger" : props.tone === "good" ? " good" : "";
  const heroCls = props.hero ? " hero" : "";
  return (
    <div className={`metric${heroCls}`}>
      <div className="metric-label">{props.label}</div>
      <div className={`metric-value${valueCls}`}>{props.value}</div>
      {props.foot ? <div className="metric-foot">{props.foot}</div> : null}
    </div>
  );
}

export function PageHeader(props: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="title-block">
        <h1>{props.title}</h1>
        {props.subtitle ? <p className="subtitle">{props.subtitle}</p> : null}
      </div>
      {props.right ? <div className="actions">{props.right}</div> : null}
    </header>
  );
}

export function Switch(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props["aria-label"]}
      disabled={props.disabled}
      className={`switch${props.checked ? " on" : ""}`}
      onClick={() => {
        if (!props.disabled) props.onChange(!props.checked);
      }}
    >
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
    </button>
  );
}

export function Chip(props: {
  tone?: "neutral" | "muted" | "good" | "warn" | "danger" | "accent" | "sev-crit" | "sev-major" | "sev-minor" | "sev-nit";
  uppercase?: boolean;
  dot?: boolean;
  children: ReactNode;
  title?: string;
}) {
  const cls = ["chip", props.tone ?? "neutral", props.uppercase ? "uppercase" : ""].filter(Boolean).join(" ");
  return (
    <span className={cls} title={props.title}>
      {props.dot ? <span className="dot" /> : null}
      {props.children}
    </span>
  );
}
