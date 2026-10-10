import * as Dialog from "@radix-ui/react-dialog";
import { X, LoaderCircle } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { Tooltip } from "./tooltip";
export function Button({
  className = "",
  variant = "primary",
  title,
  ...props
}: ComponentPropsWithRef<"button"> & {
  variant?: "primary" | "secondary" | "ghost";
}) {
  const button = <button className={`btn btn-${variant} ${className}`} {...props} />;
  return title ? <Tooltip content={title}>{button}</Tooltip> : button;
}
export function Modal({
  title,
  description,
  open,
  onOpenChange,
  children,
  className = "",
  onOpenAutoFocus,
  onCloseAutoFocus,
}: {
  title: string;
  description?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className={`dialog-content ${className}`}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          {...(!description ? { "aria-describedby": undefined } : {})}
        >
          <Dialog.Title className="dialog-title">{title}</Dialog.Title>
          {description && (
            <Dialog.Description className="muted">
              {description}
            </Dialog.Description>
          )}
          <Dialog.Close
            className="icon-button dialog-close"
            aria-label="Close dialog"
          >
            <X size={18} />
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function ErrorNotice({ error }: { error: string }) {
  return error ? (
    <div className="error" role="alert">
      {error}
    </div>
  ) : null;
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="animate-spin" size={20} /> Loading your
      workspace…
    </div>
  );
}
