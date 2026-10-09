import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "./ui/primitives";
import "./copy-issue-body.css";

/** Copy exactly the displayed Markdown draft, without saving or adding comments. */
export function CopyIssueBody({ body }: { body: string }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setStatus("idle");
    return () => { generation.current++; };
  }, [body]);
  useEffect(() => {
    if (status !== "copied") return;
    const timer = setTimeout(() => setStatus("idle"), 3000);
    return () => clearTimeout(timer);
  }, [status]);
  async function copy() {
    const current = generation.current;
    setStatus("copying");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(body);
      if (current === generation.current) setStatus("copied");
    } catch {
      if (current === generation.current) setStatus("error");
    }
  }
  return <div className="copy-issue-body">
    <Button type="button" variant="secondary" onClick={() => void copy()} disabled={status === "copying"}
      aria-label="Copy issue body" title="Copy issue Markdown without saving">
      {status === "copied" ? <Check size={15} /> : <Copy size={15} />}
      {status === "copied" ? "Copied!" : status === "copying" ? "Copying…" : "Copy body"}
    </Button>
    {status === "copied" && <span className="sr-only" role="status">Issue body copied to clipboard.</span>}
    {status === "error" && <span className="copy-issue-error" role="alert">Could not copy. Allow clipboard access and try again, or select and copy the Markdown manually.</span>}
  </div>;
}
