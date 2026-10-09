import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createLinkNode, $isLinkNode } from "@lexical/link";
import { $isCodeNode } from "@lexical/code";
import { $createTextNode, $getNodeByKey, $getSelection, $isRangeSelection, $isTextNode } from "lexical";
import type { User } from "../../shared/types";
import { mentionMarkdown } from "../../shared/mentions";

/** Only a deliberate standalone @ trigger, never emails, links or Markdown code. */
export function mentionQuery(text: string) {
  let fence = "";
  for (const line of text.split("\n")) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (match) fence = fence && match[1][0] === fence[0] ? "" : fence || match[1];
  }
  if (fence || /^(?: {4}|\t)/m.test(text.split("\n").at(-1) || "")) return null;
  const line = text.split("\n").at(-1) || "";
  let ticks = 0;
  for (const run of line.match(/(?<!\\)`+/g) || []) {
    if (!ticks) ticks = run.length;
    else if (run.length === ticks) ticks = 0;
  }
  if (ticks) return null;
  // # and ! hand completion to tags/issues instead of keeping a stale @ query.
  const match = /(?:^|[\s(])@([^@#!\n\r\[\]()`<>]{0,60})$/.exec(line);
  if (!match || /\]\([^)]*$/.test(line)) return null;
  return { query: match[1], start: text.length - match[1].length - 1, end: text.length };
}
type Match = { query: string; start: number; end: number; key?: string };

export function MentionAutocomplete({ users, mode, source, onChange }: {
  users: User[]; mode: string; source: RefObject<HTMLTextAreaElement | null>; onChange: (value: string) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const [match, setMatch] = useState<Match | null>(null);
  const [active, setActive] = useState(0);
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const dismissed = useRef("");
  const options = users.filter(user => `${user.name} ${user.email}`.toLocaleLowerCase().includes(match?.query.toLocaleLowerCase() || "")).slice(0, 20);
  const state = useRef({ match, options, active });
  state.current = { match, options, active };
  const signature = (next: Match | null) => JSON.stringify(next);
  useEffect(() => {
    dismissed.current = "";
    setMatch(null);
    const update = (next: Match | null) => {
      if (signature(next) === dismissed.current) return;
      if (signature(state.current.match) !== signature(next)) {
        setMatch(next);
        setActive(0);
      }
    };
    if (mode === "markdown") {
      const element = source.current;
      const read = () => update(element && element.selectionStart === element.selectionEnd ? mentionQuery(element.value.slice(0, element.selectionStart)) : null);
      element?.addEventListener("input", read);
      element?.addEventListener("select", read);
      element?.addEventListener("keyup", read);
      return () => { element?.removeEventListener("input", read); element?.removeEventListener("select", read); element?.removeEventListener("keyup", read); };
    }
    if (mode !== "write") return;
    return editor.registerUpdateListener(({ editorState }) => editorState.read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return update(null);
      const node = selection.anchor.getNode();
      if (!$isTextNode(node) || node.hasFormat("code") || node.getParents().some(parent => $isCodeNode(parent) || $isLinkNode(parent))) return update(null);
      const next = mentionQuery(node.getTextContent().slice(0, selection.anchor.offset));
      update(next ? { ...next, key: node.getKey() } : null);
    }));
  }, [editor, mode, source]);
  const choose = (user: User) => {
    const current = state.current.match;
    if (!current) return;
    dismissed.current = signature(current);
    setMatch(null);
    if (mode === "markdown") {
      const element = source.current;
      if (!element) return;
      const insertion = `${mentionMarkdown(user)} `;
      onChange(element.value.slice(0, current.start) + insertion + element.value.slice(current.end));
      requestAnimationFrame(() => { element.focus(); element.setSelectionRange(current.start + insertion.length, current.start + insertion.length); });
    } else editor.update(() => {
      const node = current.key ? $getNodeByKey(current.key) : null;
      if (!$isTextNode(node) || node.getTextContent().slice(current.start, current.end) !== `@${current.query}`) return;
      const selection = node.select(current.start, current.end);
      selection.insertNodes([$createLinkNode(`mention:${user.id}`).append($createTextNode(`@${user.name}`)), $createTextNode(" ")]);
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
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        setActive(index => (index + (event.key === "ArrowDown" ? 1 : -1) + current.options.length) % (current.options.length || 1));
      } else if ((event.key === "Enter" || event.key === "Tab") && current.options.length) chooseRef.current(current.options[current.active] || current.options[0]);
      else return;
      event.preventDefault(); event.stopPropagation();
    };
    const blur = () => setMatch(null);
    // Radix listens for Escape on document capture; intercept at window first.
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && event.target === element) keydown(event);
    };
    window.addEventListener("keydown", escape, true);
    element.addEventListener("keydown", keydown, true);
    element.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", escape, true); element.removeEventListener("keydown", keydown, true); element.removeEventListener("blur", blur); };
  }, [editor, mode, source]);
  useEffect(() => {
    const element = mode === "markdown" ? source.current : editor.getRootElement();
    if (!element) return;
    if (match) {
      element.setAttribute("aria-autocomplete", "list"); element.setAttribute("aria-controls", id);
      if (options.length) element.setAttribute("aria-activedescendant", `${id}-${active}`);
      else element.removeAttribute("aria-activedescendant");
    }
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    return () => {
      // The tag picker shares this input; only release our own ARIA attributes.
      if (element.getAttribute("aria-controls") === id) for (const attr of ["aria-autocomplete", "aria-controls", "aria-activedescendant"]) element.removeAttribute(attr);
    };
  }, [match, active, options.length, editor, mode, source, id]);
  if (!match) return null;
  return <div className="mention-picker" ref={list}>
    <div className="mention-picker-help">Mention a teammate · ↑↓ to choose · Enter to insert</div>
    <div role="listbox" aria-label="Mention suggestions" id={id}>
      {options.map((user, index) => <div role="option" aria-selected={index === active} id={`${id}-${index}`} key={user.id}
        className="mention-option" onPointerDown={event => event.preventDefault()} onClick={() => choose(user)}>
        <strong>@{user.name}</strong><span>{user.email}</span>
      </div>)}
    </div>
    {!options.length && <div role="status" className="mention-empty">No matching teammates</div>}
  </div>;
}
