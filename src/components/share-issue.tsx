import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, Copy, Share2 } from "lucide-react";
import { issuePath } from "../lib/workspace";
import type { Issue } from "../../shared/types";
import { Button } from "./ui/primitives";

/** Share a canonical issue URL, never the collection's current route or a draft. */
export function ShareIssue({ issue }: { issue: Issue }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const url = new URL(issuePath(issue), window.location.origin).href;
  async function copy() {
    setBusy(true);
    setError("");
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError("Could not copy automatically. Select and copy the link above.");
    } finally { setBusy(false); }
  }
  return <Popover.Root onOpenChange={() => { setCopied(false); setError(""); }}>
    <Popover.Trigger asChild>
      <Button type="button" variant="ghost" className="issue-share-button" title="Share issue" aria-label="Share issue">
        <Share2 size={16} /><span>Share</span>
      </Button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="issue-share-popover" sideOffset={6} align="end" aria-label="Share issue">
        <label>Issue link<input readOnly value={url} onFocus={(event) => event.currentTarget.select()} /></label>
        <p className="muted">Only people with access to this issue can open it.</p>
        <Button type="button" variant="secondary" onClick={() => void copy()} disabled={busy}>
          {copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "Copied!" : "Copy link"}
        </Button>
        {copied && <p role="status" className="sr-only">Issue link copied</p>}
        {error && <p role="alert">{error}</p>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
