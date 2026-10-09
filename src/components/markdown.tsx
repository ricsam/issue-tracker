import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { mentionUserId } from "../../shared/mentions";
import type { User } from "../../shared/types";
import remarkGfm from "remark-gfm";
import { safeImageUrl } from "./image-node";
import { remarkHashtags } from "./hashtag-markdown";
import { remarkIssueReferences } from "./issue-reference-markdown";
import { issueReferenceId } from "../../shared/issue-references";
import "./editor.css";

/** Raw HTML is deliberately not enabled; remote images never track workspace readers. */
export function Markdown({ children, mentionUsers = [] }: { children: string; mentionUsers?: User[] }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkHashtags, remarkIssueReferences]}
        urlTransform={(url) => mentionUserId(url) ? url : defaultUrlTransform(url)}
        components={{
          a: ({ children, href }) => {
            const id = mentionUserId(href || "");
            if (id) {
              const user = mentionUsers.find(user => user.id === id);
              return <span className="mention-chip" data-mention-user-id={id} title={user?.email || "Mentioned teammate"}>{user ? `@${user.name}` : children}</span>;
            }
            if (issueReferenceId(href || "")) return <a className="issue-reference-chip" href={href}>{children}</a>;
            return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
          },
          img: ({ src, alt }) =>
            typeof src === "string" && safeImageUrl(src) ? (
              <img src={src} alt={alt || "Attachment"} loading="lazy" />
            ) : (
              <span className="text-muted-foreground">
                [External image omitted: {alt || "image"}]
              </span>
            ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
