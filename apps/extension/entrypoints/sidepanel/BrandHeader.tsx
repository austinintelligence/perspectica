import { useEffect, useRef, useState } from "react";
import { CloseIcon, MenuIcon, PerspecticaMark } from "./Icons";

interface BrandHeaderProps {
  action: "menu" | "close";
  actionLabel: string;
  onAction: () => void;
  menuItems?: ReadonlyArray<{ label: string; onSelect: () => void }>;
}

export function shouldCompactMasthead(scrollPosition: number): boolean {
  return scrollPosition > 96;
}

export function BrandHeader({ action, actionLabel, onAction, menuItems = [] }: BrandHeaderProps) {
  const [compact, setCompact] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLElement | null>(null);

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

  const hasMenu = action === "menu" && menuItems.length > 0;
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        return;
      }
      const items = menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
      if (
        items?.length &&
        ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)
      ) {
        event.preventDefault();
        const current = Array.from(items).indexOf(document.activeElement as HTMLButtonElement);
        const nextIndex =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (current + (["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1) + items.length) %
                items.length;
        items[nextIndex]?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      if (!items?.length) return;
      const current = document.activeElement;
      const index = Array.from(items).indexOf(current as HTMLButtonElement);
      const next = event.shiftKey
        ? items[(index <= 0 ? items.length : index) - 1]
        : items[(index + 1) % items.length];
      if (
        index === -1 ||
        (!event.shiftKey && index === items.length - 1) ||
        (event.shiftKey && index === 0)
      ) {
        event.preventDefault();
        next?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() =>
      menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(),
    );
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  const activate = () => {
    if (hasMenu) {
      setMenuOpen((current) => !current);
      return;
    }
    onAction();
  };

  return (
    <header className={`brand-header${compact ? " is-compact" : ""}`}>
      <div className="brand-lockup" aria-label="Perspectica">
        <PerspecticaMark />
        <span className="brand-wordmark">Perspectica</span>
      </div>
      <button
        className="brand-action"
        type="button"
        aria-label={actionLabel}
        aria-expanded={hasMenu ? menuOpen : undefined}
        aria-haspopup={hasMenu ? "menu" : undefined}
        onClick={activate}
      >
        {action === "menu" ? <MenuIcon /> : <CloseIcon />}
      </button>
      {hasMenu && menuOpen ? (
        <nav ref={menuRef} className="masthead-menu" role="menu" aria-label="Perspectica menu">
          {menuItems.map((item) => (
            <button
              type="button"
              role="menuitem"
              key={item.label}
              onClick={() => {
                setMenuOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
