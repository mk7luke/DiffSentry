import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";

// ─────────────────────────────────────────────────────────────────────────────
// <CodeEditor> — a minimal controlled CodeMirror 6 YAML editor themed to match
// the dashboard's dark tokens. Edits flow out via onChange; external value
// changes (e.g. the form mutating the YAML) are reconciled without clobbering
// the cursor when the text already matches.
// ─────────────────────────────────────────────────────────────────────────────

const theme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--bg-deep)",
      color: "var(--text-1)",
      fontSize: "12.5px",
      border: "1px solid var(--line)",
      borderRadius: "6px",
      height: "100%",
    },
    "&.cm-focused": { outline: "none", borderColor: "var(--accent)" },
    ".cm-content": { fontFamily: "var(--font-mono)", padding: "10px 0" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--text-4)",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.03)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-2)" },
    ".cm-cursor": { borderLeftColor: "var(--accent-bright)" },
    "&.cm-editor .cm-selectionBackground, & .cm-selectionBackground": {
      backgroundColor: "rgba(110,120,255,0.25)",
    },
    ".cm-scroller": { overflow: "auto" },
  },
  { dark: true },
);

export function CodeEditor(props: {
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
  minHeight?: number;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // Keep the latest onChange without re-creating the editor each render.
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        yaml(),
        theme,
        EditorView.editable.of(!props.readOnly),
        EditorState.readOnly.of(!!props.readOnly),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // Re-create only when read-only flips; value sync is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.readOnly]);

  // Reconcile external value changes (form → YAML) without disturbing the
  // cursor when the doc already matches what's typed.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== props.value) {
      v.dispatch({ changes: { from: 0, to: current.length, insert: props.value } });
    }
  }, [props.value]);

  return <div ref={host} style={{ minHeight: props.minHeight ?? 320, display: "flex" }} />;
}
