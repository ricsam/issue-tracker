import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { AutoFocusPlugin } from "@lexical/react/LexicalAutoFocusPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  CHECK_LIST,
  TRANSFORMERS,
} from "@lexical/markdown";
import {
  $createHeadingNode,
  $createQuoteNode,
  HeadingNode,
  QuoteNode,
} from "@lexical/rich-text";
import { CodeNode } from "@lexical/code";
import {
  INSERT_UNORDERED_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_CHECK_LIST_COMMAND,
  ListItemNode,
  ListNode,
} from "@lexical/list";
import { $createLinkNode, LinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { $setBlocksType } from "@lexical/selection";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  FORMAT_TEXT_COMMAND,
  PASTE_COMMAND,
  type TextFormatType,
} from "lexical";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading2,
  Quote,
  List,
  ListOrdered,
  ListChecks,
  Link,
  Paperclip,
  Loader2,
} from "lucide-react";
import { mentionUserId } from "../../shared/mentions";
import { MentionLinkNode, mentionLinkReplacement } from "./mention-link-node";
import { MENTION_TRANSFORMER } from "./mention-transformer";
import { MentionAutocomplete } from "./mention-autocomplete";
import type { Attachment, User } from "../../shared/types";
import { IMAGE_TRANSFORMER, ImageNode } from "./image-node";
import { Markdown } from "./markdown";
import "./editor.css";

const transformers = [MENTION_TRANSFORMER, IMAGE_TRANSFORMER, CHECK_LIST, ...TRANSFORMERS];
type Mode = "write" | "markdown" | "preview";
function validLink(url: string) {
  return !!mentionUserId(url) || /^(https?:\/\/|mailto:|\/api\/uploads\/)/i.test(url);
}

function Tool({
  label,
  children,
  onClick,
  disabled,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="editor-tool"
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function EditorContents({
  value,
  onChange,
  placeholder,
  minimal,
  ariaLabel,
  autoFocus,
  mentionUsers,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  minimal: boolean;
  ariaLabel: string;
  autoFocus: boolean;
  mentionUsers: User[];
}) {
  const [editor] = useLexicalComposerContext();
  const [mode, setMode] = useState<Mode>("write");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const last = useRef(value);
  const fileInput = useRef<HTMLInputElement>(null);
  const source = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  // External reset or Markdown-source edits update the rich view, but ordinary typing never resets selection.
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      editor.update(() => $convertFromMarkdownString(value, transformers), {
        tag: ["external", "skip-dom-selection"],
      });
    }
  }, [editor, value]);

  const upload = async (files: File[]) => {
    if (uploading || mode === "preview" || !files.length) return;
    setError("");
    setUploading(true);
    try {
      for (const file of files) {
        if (file.size > 10 * 1024 * 1024)
          throw new Error("Each attachment must be 10 MiB or smaller.");
        const body = new FormData();
        body.append("file", file);
        const response = await fetch("/api/uploads", {
          method: "POST",
          body,
          credentials: "same-origin",
        });
        const data = (await response.json()) as {
          attachment?: Attachment;
          error?: string;
        };
        if (!response.ok || !data.attachment)
          throw new Error(data.error || "Upload failed. Please try again.");
        const attachment = data.attachment;
        const name = attachment.name.replace(/[\[\]\\\n\r]/g, "");
        const image = /^(image\/(png|jpeg|gif|webp))$/.test(attachment.mime);
        const url = attachment.url.replace(/\(/g, "%28").replace(/\)/g, "%29");
        if (mode === "write")
          editor.update(
            () => {
              if (!$getSelection()) $getRoot().selectEnd();
              const node = image
                ? new ImageNode(url, name)
                : $createLinkNode(url).append($createTextNode(name));
              $insertNodes([node, $createTextNode(" ")]);
            },
            { discrete: true },
          );
        if (mode === "markdown") {
          // Source mode retains unsupported Markdown (e.g. tables) verbatim.
          const current = source.current?.value ?? value;
          const text = `${current}\n${image ? "!" : ""}[${name}](${url})\n`;
          onChange(text);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  useEffect(
    () =>
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          if (!(event instanceof ClipboardEvent)) return false;
          const files = Array.from(event.clipboardData?.files || []);
          if (!files.length) return false;
          event.preventDefault();
          void upload(files);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, uploading, mode, value],
  );

  const format = (kind: TextFormatType) =>
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, kind);
  const block = (kind: "heading" | "quote" | "paragraph") =>
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection))
        $setBlocksType(selection, () =>
          kind === "heading"
            ? $createHeadingNode("h2")
            : kind === "quote"
              ? $createQuoteNode()
              : $createParagraphNode(),
        );
    });
  return (
    <div
      className="rich-editor"
      aria-busy={uploading}
      onClickCapture={(event) => {
        const link = (event.target as Element).closest?.('a[href^="mention:"]');
        if (link) event.preventDefault();
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          void upload(Array.from(e.dataTransfer.files));
        }
      }}
    >
      <div className="editor-topbar">
        <div className="editor-tabs" role="group" aria-label="Editor mode">
          {(["write", "markdown", "preview"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              aria-pressed={mode === tab}
              onClick={() => setMode(tab)}
            >
              {tab === "write"
                ? "Write"
                : tab === "markdown"
                  ? "Markdown"
                  : "Preview"}
            </button>
          ))}
        </div>
        <Tool
          label="Attach files"
          onClick={() => fileInput.current?.click()}
          disabled={uploading || mode === "preview"}
        >
          {uploading ? (
            <Loader2 className="animate-spin" size={16} />
          ) : (
            <Paperclip size={16} />
          )}
        </Tool>
        <input
          ref={fileInput}
          className="sr-only"
          type="file"
          multiple
          aria-label="Upload attachments"
          onChange={(e) => void upload(Array.from(e.target.files || []))}
        />
      </div>
      {mode === "write" && (
        <div
          className="editor-toolbar"
          role="group"
          aria-label="Text formatting"
        >
          <Tool label="Bold" onClick={() => format("bold")}>
            <Bold size={15} />
          </Tool>
          <Tool label="Italic" onClick={() => format("italic")}>
            <Italic size={15} />
          </Tool>
          <Tool label="Strikethrough" onClick={() => format("strikethrough")}>
            <Strikethrough size={15} />
          </Tool>
          <Tool label="Inline code" onClick={() => format("code")}>
            <Code size={15} />
          </Tool>
          <span className="editor-divider" />
          <Tool label="Heading" onClick={() => block("heading")}>
            <Heading2 size={15} />
          </Tool>
          <Tool label="Quote" onClick={() => block("quote")}>
            <Quote size={15} />
          </Tool>
          <Tool
            label="Bulleted list"
            onClick={() =>
              editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)
            }
          >
            <List size={15} />
          </Tool>
          <Tool
            label="Numbered list"
            onClick={() =>
              editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)
            }
          >
            <ListOrdered size={15} />
          </Tool>
          <Tool
            label="Task list"
            onClick={() =>
              editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined)
            }
          >
            <ListChecks size={15} />
          </Tool>
          <Tool
            label="Insert link"
            onClick={() => {
              const url = window.prompt(
                "Link URL (https://…); leave empty to remove link",
              );
              if (url === null) return;
              if (url && !validLink(url)) {
                setError("Use an https://, http:// or mailto: link.");
                return;
              }
              editor.dispatchCommand(TOGGLE_LINK_COMMAND, url || null);
            }}
          >
            <Link size={15} />
          </Tool>
        </div>
      )}
      <div className={mode === "write" ? "editor-surface" : "hidden"}>
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              aria-label={ariaLabel}
              aria-describedby={`${id}-help`}
              className={`editor-input markdown-content ${minimal ? "editor-minimal" : ""}`}
            />
          }
          placeholder={<div className="editor-placeholder">{placeholder}</div>}
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      {mode === "markdown" && (
        <textarea
          ref={source}
          aria-label="Markdown source"
          className="editor-source"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      )}
      {mode === "preview" && (
        <div className="editor-preview">
          {value ? (
            <Markdown mentionUsers={mentionUsers}>{value}</Markdown>
          ) : (
            <span className="text-muted-foreground">
              Nothing to preview yet.
            </span>
          )}
        </div>
      )}
      <MentionAutocomplete users={mentionUsers} mode={mode} source={source} onChange={onChange} />
      {autoFocus && <AutoFocusPlugin defaultSelection="rootStart" />}
      <HistoryPlugin />
      <ListPlugin />
      <CheckListPlugin />
      <LinkPlugin validateUrl={validLink} />
      <MarkdownShortcutPlugin transformers={transformers} />
      <OnChangePlugin
        ignoreSelectionChange
        onChange={(state, _editor, tags) => {
          if (tags.has("external") || mode !== "write") return;
          state.read(() => {
            const markdown = $convertToMarkdownString(transformers);
            if (markdown !== last.current) {
              last.current = markdown;
              onChange(markdown);
            }
          });
        }}
      />
      <div id={`${id}-help`} className="editor-help">
        {uploading
          ? "Uploading attachment…"
          : "Markdown supported. Paste, drop or attach files · 10 MiB each"}
      </div>
      {error && (
        <div role="alert" className="editor-error">
          {error}
        </div>
      )}
    </div>
  );
}

export function RichEditor({
  value,
  onChange,
  placeholder = "Write a description…",
  minimal = false,
  ariaLabel = placeholder,
  autoFocus = false,
  mentionUsers = [],
}: {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  minimal?: boolean;
  ariaLabel?: string;
  autoFocus?: boolean;
  mentionUsers?: User[];
}) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: "ThreadlineEditor",
        nodes: [
          HeadingNode,
          QuoteNode,
          CodeNode,
          ListNode,
          ListItemNode,
          LinkNode,
          MentionLinkNode,
          mentionLinkReplacement,
          ImageNode,
        ],
        editorState: () => $convertFromMarkdownString(value, transformers),
        onError: (error) => {
          throw error;
        },
        theme: {
          paragraph: "editor-paragraph",
          quote: "editor-quote",
          link: "editor-link",
          heading: { h1: "editor-h1", h2: "editor-h2", h3: "editor-h3" },
          list: {
            ul: "editor-ul",
            ol: "editor-ol",
            listitem: "editor-li",
            listitemChecked: "editor-checked",
            listitemUnchecked: "editor-unchecked",
            nested: { listitem: "editor-nested" },
          },
          text: {
            bold: "font-bold",
            italic: "italic",
            strikethrough: "line-through",
            code: "editor-code",
          },
          code: "editor-codeblock",
        },
      }}
    >
      <EditorContents
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        minimal={minimal}
        ariaLabel={ariaLabel}
        autoFocus={autoFocus}
        mentionUsers={mentionUsers}
      />
    </LexicalComposer>
  );
}
