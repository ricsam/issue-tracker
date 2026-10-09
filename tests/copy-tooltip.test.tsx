import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../src/components/ui/primitives";
import { CopyIssueBody } from "../src/components/copy-issue-body";

test("Button consumes title without changing native disabled semantics or styling", () => {
  const html = renderToStaticMarkup(<Button title="Helpful action" disabled type="button" variant="ghost" className="custom" aria-label="Action">Run</Button>);
  expect(html).not.toContain('title=');
  expect(html).toContain('disabled=""');
  expect(html).toContain('class="btn btn-ghost custom"');
  expect(html).toContain('aria-label="Action"');
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).not.toContain("<span");
});

test("copy action cannot submit forms and has a stable accessible name", () => {
  const html = renderToStaticMarkup(<CopyIssueBody body="## Issue Markdown" />);
  expect(html).toContain('type="button"');
  expect(html).toContain('aria-label="Copy issue body"');
  expect(html).not.toContain('title=');
  expect(html).not.toContain('disabled=');
  expect(html).not.toContain("## Issue Markdown");
});
