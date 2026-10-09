import * as Primitive from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";
import "./tooltip.css";

/** asChild preserves the original button, ref, styling and keyboard behavior. */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactElement }) {
  if (!content) return children;
  return (
    <Primitive.Provider delayDuration={350}>
      <Primitive.Root>
        <Primitive.Trigger asChild>{children}</Primitive.Trigger>
        <Primitive.Portal>
          <Primitive.Content className="styled-tooltip" sideOffset={6} collisionPadding={8}>
            {content}
            <Primitive.Arrow className="styled-tooltip-arrow" />
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
    </Primitive.Provider>
  );
}
