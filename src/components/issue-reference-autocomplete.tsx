import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isLinkNode } from "@lexical/link";
import { $isCodeNode } from "@lexical/code";
import { $getSelection, $isRangeSelection, $isTextNode, type TextNode } from "lexical";
import type { IssueReference } from "../../shared/types";
import { api, message } from "../lib/api";

type Match = { query: string; start: number; end: number; text: string };
/** A standalone ! trigger, not an image, URL, code example or another picker. */
export function issueReferenceQuery(text: string): Match | null {
  let fence = "";
  for (const line of text.split("\n")) {
    const run = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (run) {
      if (!fence) fence = run;
      else if (run[0] === fence[0] && run.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = "";
    }
  }
  const line = text.split("\n").at(-1) || "";
  if (fence || /^(?: {4}|\t)/.test(line)) return null;
  let ticks = 0;
  for (const run of text.match(/(?<!\\)`+/g) || []) {
    if (!ticks) ticks = run.length;
    else if (run.length === ticks) ticks = 0;
  }
  if (ticks) return null;
  const match = /(?:^|[\s(])(!([^!@#\n\r\[\]()`<>\\]{0,100}))$/.exec(line);
  if (!match || /^\d+\s/.test(match[2]!)) return null;
  const start = text.length - match[1]!.length;
  if (/\[[^\]\n]*$|\]\([^\n)]*$|<[^>\n]*$/.test(text.slice(0, start))) return null;
  return { query: match[2]!, start, end: text.length, text: match[1]! };
}

function $referenceContext() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const anchor = selection.anchor.getNode();
  if (!$isTextNode(anchor) || anchor.hasFormat("code") || anchor.getParents().some(p => $isCodeNode(p) || $isLinkNode(p))) return null;
  const nodes: TextNode[] = [anchor];
  let previous = anchor.getPreviousSibling();
  while ($isTextNode(previous) && !previous.hasFormat("code")) {
    nodes.unshift(previous); previous = previous.getPreviousSibling();
  }
  const text = nodes.slice(0, -1).map(n => n.getTextContent()).join("") + anchor.getTextContent().slice(0, selection.anchor.offset);
  const match = issueReferenceQuery(text);
  return match ? { match, nodes, selection } : null;
}

export function IssueReferenceAutocomplete({ mode, source, onChange }: {
  mode: string; source: RefObject<HTMLTextAreaElement | null>; onChange: (value: string) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const [match, setMatch] = useState<Match | null>(null);
  const [result, setResult] = useState<{ query: string; issues: IssueReference[]; error?: string } | null>(null);
  const [active, setActive] = useState(0);
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const dismissed = useRef("");
  const signature = (value: Match | null) => JSON.stringify(value);
  const options = match && result?.query === match.query ? result.issues : [];
  const loading = !!match && result?.query !== match.query;
  const state = useRef({ match, options, active });
  state.current = { match, options, active };
  useEffect(() => {
    if (!match) { setResult(null); return; }
    const controller = new AbortController();
    const query = match.query;
    // Fetch only while completing a reference; cancel stale title/number queries.
    const timer = setTimeout(() => {
      void api<{ issues: IssueReference[] }>(`/api/issues/references?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then(({ issues }) => { if (!controller.signal.aborted) setResult({ query, issues }); })
        .catch(error => { if (!controller.signal.aborted) setResult({ query, issues: [], error: message(error) }); });
    }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [match?.query]);
  useEffect(() => {
    dismissed.current = ""; setMatch(null);
    const update = (next: Match | null) => {
      if (signature(next) === dismissed.current) return;
      dismissed.current = "";
      if (signature(next) !== signature(state.current.match)) { setMatch(next); setActive(0); }
    };
    if (mode === "markdown") {
      const element = source.current;
      const read = () => update(element && element.selectionStart === element.selectionEnd ? issueReferenceQuery(element.value.slice(0, element.selectionStart)) : null);
      element?.addEventListener("input", read); element?.addEventListener("select", read); element?.addEventListener("keyup", read);
      return () => { element?.removeEventListener("input", read); element?.removeEventListener("select", read); element?.removeEventListener("keyup", read); };
    }
    if (mode === "write") return editor.registerUpdateListener(({ editorState }) => editorState.read(() => update($referenceContext()?.match ?? null)));
  }, [editor, mode, source]);
  const choose = (issue: IssueReference) => {
    const current = state.current.match;
    if (!current) return;
    const insertion = `!${issue.number} `;
    // Suppress the inserted token as well as the query until typing resumes.
    dismissed.current = signature({ query: `${issue.number} `, start: current.start, end: current.start + insertion.length, text: insertion });
    setMatch(null);
    if (mode === "markdown") {
      const element = source.current;
      if (!element || element.value.slice(current.start, current.end) !== current.text) return;
      onChange(element.value.slice(0, current.start) + insertion + element.value.slice(current.end));
      requestAnimationFrame(() => { element.focus(); element.setSelectionRange(current.start + insertion.length, current.start + insertion.length); });
    } else editor.update(() => {
      const context = $referenceContext();
      if (!context || signature(context.match) !== signature(current)) return;
      let offset = current.start;
      for (const node of context.nodes) {
        if (offset <= node.getTextContentSize()) {
          context.selection.anchor.set(node.getKey(), offset, "text");
          context.selection.insertText(insertion); break;
        }
        offset -= node.getTextContentSize();
      }
    });
  };
  const chooseRef = useRef(choose); chooseRef.current = choose;
  useEffect(() => {
    const element = mode === "markdown" ? source.current : editor.getRootElement();
    if (!element || mode === "preview") return;
    const keydown = (event: KeyboardEvent) => {
      const current = state.current;
      if (!current.match || event.isComposing) return;
      if (event.key === "Escape") { dismissed.current = signature(current.match); setMatch(null); }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") setActive(index => (index + (event.key === "ArrowDown" ? 1 : -1) + current.options.length) % (current.options.length || 1));
      else if ((event.key === "Enter" || event.key === "Tab") && current.options.length) chooseRef.current(current.options[current.active] || current.options[0]!);
      else return;
      event.preventDefault(); event.stopPropagation();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && event.target === element) keydown(event); };
    let pointerDown = false;
    let blurred = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const down = () => { pointerDown = true; };
    const closeAfterClick = () => { clearTimeout(timer); pointerDown = false; if (blurred) { blurred = false; setMatch(null); } };
    const up = () => { pointerDown = false; timer = setTimeout(closeAfterClick, 0); };
    // Keep the in-flow menu mounted until a Save/Create pointer click completes.
    const blur = () => { if (pointerDown) blurred = true; else setMatch(null); };
    window.addEventListener("pointerdown", down, true); window.addEventListener("pointerup", up, true);
    window.addEventListener("click", closeAfterClick, true); window.addEventListener("pointercancel", closeAfterClick, true);
    window.addEventListener("keydown", escape, true); element.addEventListener("keydown", keydown, true); element.addEventListener("blur", blur);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", down, true); window.removeEventListener("pointerup", up, true);
      window.removeEventListener("click", closeAfterClick, true); window.removeEventListener("pointercancel", closeAfterClick, true);
      window.removeEventListener("keydown", escape, true); element.removeEventListener("keydown", keydown, true); element.removeEventListener("blur", blur);
    };
  }, [editor, mode, source]);
  useEffect(() => {
    const element = mode === "markdown" ? source.current : editor.getRootElement();
    if (!element) return;
    if (match) {
      element.setAttribute("aria-autocomplete", "list"); element.setAttribute("aria-controls", id);
      if (options.length) element.setAttribute("aria-activedescendant", `${id}-${Math.min(active, options.length - 1)}`);
      else element.removeAttribute("aria-activedescendant");
    }
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    return () => {
      if (element.getAttribute("aria-controls") === id) for (const attr of ["aria-autocomplete", "aria-controls", "aria-activedescendant"]) element.removeAttribute(attr);
    };
  });
  if (!match) return null;
  return <div className="issue-reference-picker" ref={list}>
    <div className="issue-reference-picker-help">Reference an issue · ↑↓ to choose · Enter or Tab to insert</div>
    <div role="listbox" aria-label="Issue suggestions" id={id} aria-busy={loading}>
      {options.map((issue, index) => <div role="option" aria-selected={index === Math.min(active, options.length - 1)} id={`${id}-${index}`} key={issue.id}
        className="issue-reference-option" onPointerDown={event => event.preventDefault()} onClick={() => choose(issue)}>
        <strong>!{issue.number} {issue.title}</strong><span>{issue.state === "closed" ? "Closed" : "Open"}</span>
      </div>)}
    </div>
    {!options.length && <div role="status" className="issue-reference-empty">{loading ? "Finding issues…" : result?.error || "No matching issues"}</div>}
  </div>;
}
