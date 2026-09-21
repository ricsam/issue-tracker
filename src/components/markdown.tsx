import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeImageUrl } from "./image-node";
import "./editor.css";

/** Raw HTML is deliberately not enabled; remote images never track workspace readers. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
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
