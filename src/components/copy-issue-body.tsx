import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "./ui/primitives";
import { Notification, useNotification } from "./ui/snackbar";
import "./copy-issue-body.css";

/** Copy exactly the displayed Markdown draft, without saving or adding comments. */
export function CopyIssueBody({ body, iconOnly = false }: { body: string; iconOnly?: boolean }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const generation = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const [inlineNotice, setInlineNotice] = useState<{ message: string; variant: "success" | "error" } | null>(null);
  const notify = useNotification();
  useEffect(() => {
    generation.current++;
    setStatus("idle");
    setInlineNotice(null);
    return () => { generation.current++; };
  }, [body]);
  useEffect(() => {
    if (status !== "copied") return;
    const timer = setTimeout(() => setStatus("idle"), 3000);
    return () => clearTimeout(timer);
  }, [status]);
  async function copy() {
    const current = generation.current;
    const inDialog = !!root.current?.closest('[role="dialog"]');
    const feedback = (text: string, variant: "success" | "error" = "success") => {
      if (inDialog) setInlineNotice({ message: text, variant });
      else notify(text, variant);
    };
    setStatus("copying");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(body);
      if (current === generation.current) { setStatus("copied"); feedback("Issue body copied to clipboard."); }
    } catch {
      if (current === generation.current) { setStatus("error"); feedback("Could not copy. Allow clipboard access and try again, or select and copy the Markdown manually.", "error"); }
    }
  }
  return <div ref={root} className="copy-issue-body">
    <Button type="button" variant={iconOnly ? "ghost" : "secondary"} className={iconOnly ? "copy-issue-icon" : undefined} onClick={() => void copy()} disabled={status === "copying"}
      aria-label="Copy issue body" title="Copy issue Markdown without saving">
      {status === "copied" ? <Check size={15} /> : <Copy size={15} />}
      <span className={iconOnly ? "sr-only" : undefined}>{status === "copied" ? "Copied!" : status === "copying" ? "Copying…" : "Copy body"}</span>
    </Button>
    {inlineNotice && <Notification message={inlineNotice.message} variant={inlineNotice.variant} onDismiss={() => setInlineNotice(null)} />}
  </div>;
}
