import { Fragment, type ReactNode } from "react";

// Lightweight, dependency-free syntax highlighter — same spirit as JsonView's
// regex tokenizer (web/src/components/JsonView.tsx), generalised to a handful of
// language families. It is deliberately approximate: a single regex splits a
// line into comments / strings / numbers / identifiers, and identifiers are
// classified against a per-language keyword set. Good enough to make a diff
// readable; it never tries to be a full parser. All colours come from the
// existing CSS tokens (see .hl-* rules in base.css), so it themes for free.

const COMMON = [
  "if", "else", "for", "while", "do", "switch", "case", "default", "break",
  "continue", "return", "function", "class", "new", "try", "catch", "finally",
  "throw", "import", "export", "from", "as", "const", "let", "var", "this",
  "super", "extends", "implements", "interface", "type", "enum", "public",
  "private", "protected", "static", "async", "await", "yield", "void", "in",
  "of", "typeof", "instanceof", "delete", "with", "package",
];

const LANG_KEYWORDS: Record<string, string[]> = {
  ts: [...COMMON, "readonly", "namespace", "declare", "abstract", "keyof", "infer", "satisfies", "is"],
  js: COMMON,
  py: [
    "def", "class", "return", "if", "elif", "else", "for", "while", "import",
    "from", "as", "try", "except", "finally", "raise", "with", "lambda", "pass",
    "yield", "async", "await", "global", "nonlocal", "del", "assert", "in", "is",
    "not", "and", "or", "self",
  ],
  go: [
    "func", "package", "import", "var", "const", "type", "struct", "interface",
    "map", "chan", "go", "defer", "return", "if", "else", "for", "range",
    "switch", "case", "default", "break", "continue", "select", "fallthrough",
  ],
  rs: [
    "fn", "let", "mut", "const", "struct", "enum", "impl", "trait", "use", "pub",
    "mod", "match", "if", "else", "for", "while", "loop", "return", "self",
    "async", "await", "move", "ref", "where", "dyn", "as", "crate",
  ],
  rb: [
    "def", "class", "module", "end", "if", "elsif", "else", "unless", "while",
    "until", "for", "do", "begin", "rescue", "ensure", "return", "yield",
    "require", "self", "then", "case", "when",
  ],
  clike: [...COMMON, "struct", "union", "namespace", "template", "using", "virtual", "override", "final"],
  sh: ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "return", "export", "local"],
  yaml: [],
  json: [],
  css: [],
  markup: [],
  plain: [],
};

const LITERALS = new Set(["true", "false", "null", "undefined", "None", "True", "False", "nil", "NULL", "void"]);

// Comments: // and /* */ for C-likes; # for the hash-comment languages. Strings
// cover ", ', and `. Numbers and identifiers round it out. Order matters.
const TOKEN_RE_HASH =
  /(\/\/[^\n]*|#[^\n]*)|(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)/g;
const TOKEN_RE_SLASH =
  /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)/g;

const HASH_LANGS = new Set(["py", "rb", "sh", "yaml"]);

/** Highlight a single line of code into themed spans. */
export function highlightLine(content: string, lang: string): ReactNode {
  if (lang === "plain" || lang === "json" || content.length === 0) {
    return content;
  }
  const keywords = new Set(LANG_KEYWORDS[lang] ?? []);
  const re = HASH_LANGS.has(lang) ? TOKEN_RE_HASH : TOKEN_RE_SLASH;
  re.lastIndex = 0;

  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) out.push(content.slice(last, m.index));
    const [tok, lineCmt, blockCmt, str, num, ident] = m;
    if (lineCmt || blockCmt) {
      out.push(<span key={key++} className="hl-com">{tok}</span>);
    } else if (str) {
      out.push(<span key={key++} className="hl-str">{tok}</span>);
    } else if (num) {
      out.push(<span key={key++} className="hl-num">{tok}</span>);
    } else if (ident) {
      let cls: string | null = null;
      if (keywords.has(ident)) cls = "hl-kw";
      else if (LITERALS.has(ident)) cls = "hl-lit";
      else if (content[re.lastIndex] === "(") cls = "hl-fn";
      else if (/^[A-Z]/.test(ident)) cls = "hl-type";
      out.push(cls ? <span key={key++} className={cls}>{tok}</span> : tok);
    } else {
      out.push(tok);
    }
    last = re.lastIndex;
  }
  if (last < content.length) out.push(content.slice(last));
  return <Fragment>{out}</Fragment>;
}
