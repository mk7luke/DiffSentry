import { createContext, useContext } from "react";
import type { JsonSchema } from "../api/types";
import { emptyValueFor, humanizeKey } from "../lib/schema";

// When true, every control renders disabled — used for viewers / repos with no
// installation, so the form matches the YAML editor's read-only state and the
// blocked commit button.
const DisabledCtx = createContext(false);

// ─────────────────────────────────────────────────────────────────────────────
// <ConfigForm> — a schema-driven editor for .diffsentry.yaml. It renders the
// JSON schema the API ships: booleans → tri-state selects (default/on/off so
// "unset" stays distinct from "false"), enums → selects, strings → inputs,
// string arrays → glob/keyword list editors, object arrays → repeatable cards.
//
// It is one half of the editor; the raw YAML tab is the other. Both edit the
// same parsed object, so a change here re-serializes to YAML and vice-versa.
// ─────────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function setProp(obj: Obj, key: string, value: unknown): Obj {
  const next = { ...obj };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

function BoolField({ value, onChange }: { value: unknown; onChange: (v: boolean | undefined) => void }) {
  const disabled = useContext(DisabledCtx);
  const state = value === undefined ? "" : value ? "on" : "off";
  return (
    <select
      className="cfg-input"
      disabled={disabled}
      value={state}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? undefined : v === "on");
      }}
    >
      <option value="">default</option>
      <option value="on">on</option>
      <option value="off">off</option>
    </select>
  );
}

function EnumField({
  schema,
  value,
  onChange,
}: {
  schema: JsonSchema;
  value: unknown;
  onChange: (v: string | undefined) => void;
}) {
  const disabled = useContext(DisabledCtx);
  return (
    <select
      className="cfg-input"
      disabled={disabled}
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
    >
      <option value="">(default)</option>
      {(schema.enum ?? []).map((opt) => (
        <option key={String(opt)} value={String(opt)}>
          {String(opt)}
        </option>
      ))}
    </select>
  );
}

function StringField({
  schema,
  value,
  required,
  onChange,
}: {
  schema: JsonSchema;
  value: unknown;
  required?: boolean;
  onChange: (v: string | undefined) => void;
}) {
  const disabled = useContext(DisabledCtx);
  const str = typeof value === "string" ? value : "";
  const mono = schema.widget === "glob" || schema.widget === "regex";
  const set = (raw: string) => onChange(raw === "" && !required ? undefined : raw);
  if (schema.widget === "multiline") {
    return (
      <textarea
        className={`cfg-input${mono ? " mono" : ""}`}
        rows={3}
        disabled={disabled}
        value={str}
        onChange={(e) => set(e.target.value)}
      />
    );
  }
  return (
    <input
      className={`cfg-input${mono ? " mono" : ""}`}
      disabled={disabled}
      value={str}
      placeholder={schema.widget === "glob" ? "src/**/*.ts" : schema.widget === "regex" ? "regex source" : ""}
      onChange={(e) => set(e.target.value)}
    />
  );
}

function NumberField({
  schema,
  value,
  onChange,
}: {
  schema: JsonSchema;
  value: unknown;
  onChange: (v: number | undefined) => void;
}) {
  const disabled = useContext(DisabledCtx);
  return (
    <input
      className="cfg-input"
      type="number"
      disabled={disabled}
      min={schema.minimum}
      value={typeof value === "number" ? value : ""}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") return onChange(undefined);
        const n = Number(raw);
        onChange(Number.isFinite(n) ? n : undefined);
      }}
    />
  );
}

function StringArrayField({ value, item, onChange }: { value: unknown; item: JsonSchema; onChange: (v: string[] | undefined) => void }) {
  const disabled = useContext(DisabledCtx);
  const arr = Array.isArray(value) ? (value as string[]) : [];
  const mono = item.widget === "glob" || item.widget === "regex";
  const update = (next: string[]) => onChange(next.length ? next : undefined);
  return (
    <div className="cfg-list">
      {arr.map((v, i) => (
        <div className="cfg-list-row" key={i}>
          <input
            className={`cfg-input${mono ? " mono" : ""}`}
            disabled={disabled}
            value={v ?? ""}
            onChange={(e) => {
              const next = [...arr];
              next[i] = e.target.value;
              update(next);
            }}
          />
          <button type="button" className="btn btn-ghost cfg-remove" disabled={disabled} onClick={() => update(arr.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-ghost cfg-add" disabled={disabled} onClick={() => update([...arr, ""])}>
        + Add
      </button>
    </div>
  );
}

function ObjectArrayField({ value, item, onChange }: { value: unknown; item: JsonSchema; onChange: (v: Obj[] | undefined) => void }) {
  const disabled = useContext(DisabledCtx);
  const arr = Array.isArray(value) ? (value as Obj[]) : [];
  const update = (next: Obj[]) => onChange(next.length ? next : undefined);
  return (
    <div className="cfg-list">
      {arr.map((entry, i) => (
        <div className="cfg-card" key={i}>
          <div className="cfg-card-head">
            <span className="mono muted">#{i + 1}</span>
            <button type="button" className="btn btn-ghost cfg-remove" disabled={disabled} onClick={() => update(arr.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
          <ObjectFields
            schema={item}
            value={entry ?? {}}
            onChange={(v) => {
              const next = [...arr];
              next[i] = v;
              update(next);
            }}
          />
        </div>
      ))}
      <button type="button" className="btn btn-ghost cfg-add" disabled={disabled} onClick={() => update([...arr, emptyValueFor(item) as Obj])}>
        + Add
      </button>
    </div>
  );
}

/** Renders one schema node as a labelled row (dispatching by type). */
function Field({
  name,
  schema,
  value,
  required,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  required?: boolean;
  onChange: (v: unknown) => void;
}) {
  // Nested object → fieldset.
  if (schema.type === "object") {
    return (
      <fieldset className="cfg-fieldset">
        <legend>{humanizeKey(name)}</legend>
        <ObjectFields schema={schema} value={(value as Obj) ?? {}} onChange={onChange} />
      </fieldset>
    );
  }

  const isObjectArray = schema.type === "array" && schema.items?.type === "object";
  // Object arrays render as full-width stacked cards rather than a label row.
  if (isObjectArray) {
    return (
      <fieldset className="cfg-fieldset">
        <legend>{humanizeKey(name)}</legend>
        {schema.description ? <p className="cfg-hint">{schema.description}</p> : null}
        <ObjectArrayField value={value} item={schema.items as JsonSchema} onChange={onChange} />
      </fieldset>
    );
  }

  let control: JSX.Element;
  if (schema.type === "boolean") control = <BoolField value={value} onChange={onChange} />;
  else if (schema.enum) control = <EnumField schema={schema} value={value} onChange={onChange} />;
  else if (schema.type === "integer" || schema.type === "number") control = <NumberField schema={schema} value={value} onChange={onChange} />;
  else if (schema.type === "array") control = <StringArrayField value={value} item={schema.items as JsonSchema} onChange={onChange} />;
  else control = <StringField schema={schema} value={value} required={required} onChange={onChange} />;

  return (
    <label className="cfg-row">
      <span className="cfg-label">
        {humanizeKey(name)}
        {required ? <span className="cfg-req"> *</span> : null}
        {schema.description ? <span className="cfg-hint">{schema.description}</span> : null}
      </span>
      {control}
    </label>
  );
}

/** Renders every property of an object schema in declaration order. */
function ObjectFields({ schema, value, onChange }: { schema: JsonSchema; value: Obj; onChange: (v: Obj) => void }) {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  return (
    <div className="cfg-fields">
      {Object.entries(props).map(([key, child]) => (
        <Field
          key={key}
          name={key}
          schema={child}
          value={value?.[key]}
          required={required.has(key)}
          onChange={(v) => onChange(setProp(value ?? {}, key, v))}
        />
      ))}
    </div>
  );
}

export function ConfigForm({
  schema,
  value,
  onChange,
  disabled,
}: {
  schema: JsonSchema;
  value: Obj;
  onChange: (v: Obj) => void;
  disabled?: boolean;
}) {
  return (
    <DisabledCtx.Provider value={!!disabled}>
      <ObjectFields schema={schema} value={value} onChange={onChange} />
    </DisabledCtx.Provider>
  );
}
