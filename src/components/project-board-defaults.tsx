import { useState } from "react";
import type { BoardSettings } from "../../shared/types";
import type { BoardFilterState } from "./board-filters";
import { api, message } from "../lib/api";
import { Button, ErrorNotice } from "./ui/primitives";
import "./project-board-defaults.css";

/** Shared defaults are explicit owner actions; normal filter edits stay local. */
export function ProjectBoardDefaults({ slug, defaults, filters, overridden, owner, disabled, onReset, onSaved }: {
  slug: string;
  defaults: BoardFilterState | null | undefined;
  filters: BoardFilterState;
  overridden: boolean;
  owner: boolean;
  disabled: boolean;
  onReset: () => void;
  onSaved: (filters: BoardFilterState | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function save(filters: BoardFilterState | null) {
    if (busy || disabled || !owner) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const { board } = await api<{ board: BoardSettings }>(`/api/projects/${encodeURIComponent(slug)}/board/default-filters`, {
        method: "PATCH", body: JSON.stringify({ filters }),
      });
      onSaved(board.defaultFilters ?? null);
      setNotice(filters ? "Project defaults saved. Browser overrides are unchanged." : "Project defaults removed. Browsers without overrides now hide closed issues.");
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  return <section className="project-board-defaults" aria-label="Project filter defaults">
    <div className="project-board-defaults-row">
      <span className="muted">{overridden ? "Using your browser's filter overrides." : defaults ? "Using project default filters." : "Using the default open-issues filter."} Filter changes affect only this browser.</span>
      {overridden && <Button variant="ghost" disabled={busy || disabled} onClick={() => { onReset(); setNotice(""); }}>Restore default filters</Button>}
      {owner && <>
        <Button variant="ghost" disabled={busy || disabled} onClick={() => void save(filters)}>{busy ? "Saving defaults…" : "Save filters as project default"}</Button>
        {defaults && <Button variant="ghost" disabled={busy || disabled} onClick={() => void save(null)}>Remove project default</Button>}
      </>}
    </div>
    {owner && <p className="muted settings-help">As project owner, you can set defaults for everyone without a browser override. Search and lane visibility stay personal.</p>}
    <p role="status" className={notice ? "settings-help" : "sr-only"}>{notice}</p>
    <ErrorNotice error={error} />
  </section>;
}
