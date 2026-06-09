import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";

const VIEWPORT_PAD = 8;

function clampBalloonPosition(
  anchorRect: DOMRect,
  balloonWidth: number,
  balloonHeight: number
): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = anchorRect.right + 6;
  let top = anchorRect.top + anchorRect.height / 2 - balloonHeight / 2;

  if (left + balloonWidth > vw - VIEWPORT_PAD) {
    left = anchorRect.left - balloonWidth - 6;
  }
  if (left < VIEWPORT_PAD) left = VIEWPORT_PAD;

  if (top < VIEWPORT_PAD) top = VIEWPORT_PAD;
  if (top + balloonHeight > vh - VIEWPORT_PAD) {
    top = Math.max(VIEWPORT_PAD, vh - balloonHeight - VIEWPORT_PAD);
  }

  return { top, left };
}

export function HelpPopover({
  content,
  label = "Help",
  size = 15
}: {
  content: ReactNode;
  label?: string;
  size?: number;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const balloonRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const balloon = balloonRef.current;
    if (!trigger || !balloon) return;
    const anchorRect = trigger.getBoundingClientRect();
    const { width, height } = balloon.getBoundingClientRect();
    setPos(clampBalloonPosition(anchorRect, width, height));
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => reposition());
    const onResize = () => reposition();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [open, reposition, content]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || balloonRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen((o) => !o);
  };

  return (
    <span className="help-popover-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="help-popover-trigger"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={toggle}
      >
        <CircleHelp size={size} aria-hidden />
      </button>
      {open && (
        <div
          ref={balloonRef}
          id={id}
          role="dialog"
          aria-label={label}
          className="help-popover-balloon"
          style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}
          onClick={(e) => e.stopPropagation()}
        >
          {content}
        </div>
      )}
    </span>
  );
}

export function PageTitleWithHelp({
  title,
  help,
  helpLabel
}: {
  title: string;
  help: ReactNode;
  helpLabel?: string;
}) {
  return (
    <div className="page-title-row">
      <h1 className="page-title">{title}</h1>
      <HelpPopover content={help} label={helpLabel ?? `About ${title}`} />
    </div>
  );
}

export function FormLabelWithHelp({
  children,
  help,
  helpLabel,
  htmlFor
}: {
  children: ReactNode;
  help: ReactNode;
  helpLabel?: string;
  htmlFor?: string;
}) {
  return (
    <label className="form-label form-label-with-help" htmlFor={htmlFor}>
      <span>{children}</span>
      <HelpPopover content={help} label={helpLabel ?? (typeof children === "string" ? `${children} help` : "Field help")} />
    </label>
  );
}
