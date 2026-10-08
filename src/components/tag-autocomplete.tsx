import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isLinkNode } from "@lexical/link";
import { $isCodeNode } from "@lexical/code";
import { $getSelection, $isRangeSelection, $isTextNode, type TextNode } from "lexical";
import { labelMarkdown } from "../../shared/labels";

type Match = { query: string; start: number; end: number; text: string };
/** Deliberate prose triggers only. Unfinished Markdown constructs are excluded too. */
export function tagQuery(text: string): Match | null {
  let fence = "";
  for (const line of text.split("\n")) {
    const run = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (run) {
      if (!fence) fence = run;
      else if (run[0] === fence[0] && run.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = "";
    }
  }
  if (fence) return null;
  const line = text.split("\n").at(-1) || "";
  if (/^(?: {4}|\t)/.test(line)) return null;
  let ticks = 0;
  for (const run of text.match(/(?<!\\)`+/g) || []) {
    if (!ticks) ticks = run.length;
    else if (run.length === ticks) ticks = 0;
  }
  if (ticks) return null;
  const match = /(?:^|[\s(])(#(?:\[([^\]\r\n#]{0,100})|([\p{L}\p{N}\p{M}_-]{0,100})))$/u.exec(line);
  if (!match) return null;
  const start = text.length - match[1].length;
  const before = text.slice(0, start);
  // Link labels/destinations, images, autolinks and raw HTML are not prose.
  if (/\[[^\]\n]*$|\]\([^\n)]*$|<[^>\n]*$/.test(before)) return null;
  let query = match[2] ?? match[3];
  try { query = decodeURIComponent(query); } catch { /* Allow incomplete percent escapes while typing. */ }
  return { query, start, end: text.length, text: match[1] };
}

/** Read the contiguous prose run, including HashtagNode fragments. */
export function $tagContext() {
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
  const match = tagQuery(text);
  return match ? { match, nodes, selection } : null;
}

export function TagAutocomplete({ tags, mode, source, onChange }: {
  tags: string[]; mode: string; source: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const [match, setMatch] = useState<Match | null>(null);
  const [active, setActive] = useState(0);
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const dismissed = useRef("");
  const signature = (value: Match | null) => JSON.stringify(value);
  const options = [...new Set(tags)].filter(tag => tag && tag.toLocaleLowerCase().includes(match?.query.toLocaleLowerCase() || "")).slice(0, 20);
  const state = useRef({ match, options, active });
  state.current = { match, options, active };
  useEffect(() => {
    dismissed.current = ""; setMatch(null);
    const update = (next: Match | null) => {
      if (signature(next) === dismissed.current) return;
      dismissed.current = "";
      if (signature(next) !== signature(state.current.match)) { setMatch(next); setActive(0); }
    };
    if (mode === "markdown") {
      const element = source.current;
      const read = () => update(element && element.selectionStart === element.selectionEnd ? tagQuery(element.value.slice(0, element.selectionStart)) : null);
      element?.addEventListener("input", read); element?.addEventListener("select", read); element?.addEventListener("keyup", read);
      return () => { element?.removeEventListener("input", read); element?.removeEventListener("select", read); element?.removeEventListener("keyup", read); };
    }
    if (mode === "write") return editor.registerUpdateListener(({ editorState }) => editorState.read(() => update($tagContext()?.match ?? null)));
  }, [editor, mode, source]);
  const choose = (tag: string) => {
    const current = state.current.match;
    if (!current) return;
    dismissed.current = signature(current); setMatch(null);
    const insertion = `${labelMarkdown(tag)} `;
    if (mode === "markdown") {
      const element = source.current;
      if (!element || element.value.slice(current.start, current.end) !== current.text) return;
      onChange(element.value.slice(0, current.start) + insertion + element.value.slice(current.end));
      requestAnimationFrame(() => { element.focus(); element.setSelectionRange(current.start + insertion.length, current.start + insertion.length); });
    } else editor.update(() => {
      const context = $tagContext();
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
      else if ((event.key === "Enter" || event.key === "Tab") && current.options.length) chooseRef.current(current.options[current.active] || current.options[0]);
      else return;
      event.preventDefault(); event.stopPropagation();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && event.target === element) keydown(event); };
    let pointerDown = false;
    let blurred = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const down = () => { pointerDown = true; };
    const closeAfterClick = () => {
      clearTimeout(timer);
      pointerDown = false;
      if (blurred) { blurred = false; setMatch(null); }
    };
    const up = () => { pointerDown = false; timer = setTimeout(closeAfterClick, 0); };
    // Removing an in-flow menu on pointer blur moves the Save/Create button
    // between mousedown and click. Keep its layout until the click is dispatched.
    const blur = () => { if (pointerDown) blurred = true; else setMatch(null); };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("click", closeAfterClick, true);
    window.addEventListener("pointercancel", closeAfterClick, true);
    window.addEventListener("keydown", escape, true); element.addEventListener("keydown", keydown, true); element.addEventListener("blur", blur);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", down, true); window.removeEventListener("pointerup", up, true);
      window.removeEventListener("click", closeAfterClick, true); window.removeEventListener("pointercancel", closeAfterClick, true);
      window.removeEventListener("keydown", escape, true); element.removeEventListener("keydown", keydown, true); element.removeEventListener("blur", blur);
    };
  }, [editor, mode, source]);
  // Only clear attributes that belong to this picker, never the mention picker.
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
  return <div className="tag-picker" ref={list}>
    <div className="tag-picker-help">Existing tags · ↑↓ to choose · Enter or Tab to insert</div>
    <div role="listbox" aria-label="Tag suggestions" id={id}>
      {options.map((tag, index) => <div role="option" aria-selected={index === Math.min(active, options.length - 1)} id={`${id}-${index}`} key={tag}
        className="tag-option" onPointerDown={event => event.preventDefault()} onClick={() => choose(tag)}>#{tag}</div>)}
    </div>
    {!options.length && <div role="status" className="tag-empty">No matching tags</div>}
  </div>;
}
