import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ArrowLeft, ArrowRight, Check, ChevronDown, CircleCheck, CircleSlash } from "lucide-react";
import type { IssueCloseReason, IssueReference } from "../../shared/types";
import { api, message } from "../lib/api";
import { Button, ErrorNotice } from "./ui/primitives";
import "./close-issue-button.css";

import { closeReasonLabels } from "../lib/issue-close-reasons";
const reasons: { value: IssueCloseReason; label: string; description: string }[] = [
  { value: "completed", label: "Close as completed", description: "Done, closed, fixed, resolved" },
  { value: "not_planned", label: "Close as not planned", description: "Won’t fix, can’t repro, stale" },
  { value: "duplicate", label: "Close as duplicate", description: "Duplicate of another issue" },
];

/** Selecting a reason never closes the issue. The main action submits the selected reason and comment together. */
export function CloseIssueButton({ issueId, hasComment, disabled, closing, onClose }: {
  issueId: string;
  hasComment: boolean;
  disabled: boolean;
  closing: boolean;
  onClose: (reason: IssueCloseReason, duplicateOfId?: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState<IssueCloseReason>("completed");
  const [duplicate, setDuplicate] = useState<IssueReference | null>(null);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const Icon = reason === "completed" ? CircleCheck : CircleSlash;
  const label = hasComment ? "Close with comment" : reasons.find((item) => item.value === reason)!.label;
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (open && !picking) menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open, picking]);
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = (index + 1) % items.length; break;
      case "ArrowUp": next = (index - 1 + items.length) % items.length; break;
      case "Home": next = 0; break;
      case "End": next = items.length - 1; break;
      default: return;
    }
    event.preventDefault(); items[next]?.focus();
  }
  return <div className="close-issue-control">
    <div className="close-issue-split">
      <Button type="button" variant="secondary" disabled={disabled} className="close-issue-submit"
        title={`Close as ${closeReasonLabels[reason].toLowerCase()}${duplicate && reason === "duplicate" ? ` of !${duplicate.number}` : ""}`}
        onClick={() => void onClose(reason, reason === "duplicate" ? duplicate?.id : undefined)}>
        <Icon size={16} aria-hidden="true" className={`close-reason-icon ${reason}`} />
        {closing ? "Closing…" : label}
      </Button>
      <Popover.Root open={open} onOpenChange={(value) => { setOpen(value); if (!value) setPicking(false); }}>
        <Popover.Trigger asChild>
          <Button type="button" variant="secondary" disabled={disabled} aria-label="Choose close reason" className="close-issue-toggle"
            onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}>
            <ChevronDown size={16} aria-hidden="true" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal><Popover.Content className="close-reason-popover" align="end" side="top" sideOffset={6} collisionPadding={12}
          aria-label={picking ? "Choose duplicate issue" : "Choose close reason"}
          onOpenAutoFocus={(event) => { event.preventDefault(); menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus(); }}
          onEscapeKeyDown={(event) => event.stopPropagation()}>
          {picking ? <DuplicatePicker issueId={issueId} onBack={() => setPicking(false)} onSelect={(target) => {
            setDuplicate(target); setReason("duplicate"); setOpen(false); setPicking(false);
          }} /> : <div ref={menu} role="menu" aria-label="Close reason" onKeyDown={menuKeys}>
            {reasons.map((item) => {
              const ReasonIcon = item.value === "completed" ? CircleCheck : CircleSlash;
              return <button type="button" role="menuitemradio" aria-checked={reason === item.value} tabIndex={-1} key={item.value}
                className="close-reason-option" onClick={() => {
                  if (item.value === "duplicate") setPicking(true);
                  else { setReason(item.value); setOpen(false); }
                }}>
                <Check size={16} aria-hidden="true" className={reason === item.value ? "" : "unchecked"} />
                <ReasonIcon size={19} aria-hidden="true" className={`close-reason-icon ${item.value}`} />
                <span><strong>{item.label}</strong><small>{item.description}</small></span>
                {item.value === "duplicate" && <ArrowRight size={16} aria-hidden="true" />}
              </button>;
            })}
          </div>}
        </Popover.Content></Popover.Portal>
      </Popover.Root>
    </div>
    {reason === "duplicate" && duplicate && <small className="close-duplicate-selection">Duplicate of !{duplicate.number}</small>}
  </div>;
}

function DuplicatePicker({ issueId, onBack, onSelect }: {
  issueId: string;
  onBack: () => void;
  onSelect: (issue: IssueReference) => void;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ query: string; issues: IssueReference[]; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const loading = result?.query !== query;
  useEffect(() => { search.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<{ issues: IssueReference[] }>(`/api/issues/references?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal })
        .then(({ issues }) => { if (!controller.signal.aborted) setResult({ query, issues }); })
        .catch((cause) => { if (!controller.signal.aborted) setResult({ query, issues: [], error: message(cause) }); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, retry]);
  const options = loading ? [] : (result?.issues ?? []).filter((issue) => issue.id !== issueId && issue.state !== "draft");
  return <div className="close-duplicate-picker">
    <Button type="button" variant="ghost" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" /> Close reasons</Button>
    <label>Duplicate of<input ref={search} type="search" maxLength={300} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by title or !number" /></label>
    <ErrorNotice error={!loading ? result?.error ?? "" : ""} />
    {!loading && result?.error && <Button type="button" variant="secondary" onClick={() => { setResult(null); setRetry((value) => value + 1); }}>Retry search</Button>}
    <div className="close-duplicate-options" aria-label="Matching issues">
      {options.map((issue) => <button type="button" key={issue.id} onClick={() => onSelect(issue)}>
        <strong>!{issue.number}</strong> {issue.title}
      </button>)}
    </div>
    {loading ? <p role="status">Finding issues…</p> : !options.length && !result?.error ? <p role="status">No matching issues.</p> : null}
    <small className="muted">Select an issue, then use the close button to confirm.</small>
  </div>;
}
