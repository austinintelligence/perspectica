import { useEffect, useState } from "react";
import { CloseIcon, MenuIcon, PerspecticaMark } from "./Icons";

interface BrandHeaderProps {
  action: "menu" | "close";
  actionLabel: string;
  onAction: () => void;
}

export function shouldCompactMasthead(scrollPosition: number): boolean {
  return scrollPosition > 96;
}

export function BrandHeader({ action, actionLabel, onAction }: BrandHeaderProps) {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setCompact(shouldCompactMasthead(window.scrollY));
      });
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update);
    };
  }, []);

  return (
    <header className={`brand-header${compact ? " is-compact" : ""}`}>
      <div className="brand-lockup" aria-label="Perspectica">
        <PerspecticaMark />
        <span className="brand-wordmark">Perspectica</span>
      </div>
      <button className="brand-action" type="button" aria-label={actionLabel} onClick={onAction}>
        {action === "menu" ? <MenuIcon /> : <CloseIcon />}
      </button>
    </header>
  );
}
