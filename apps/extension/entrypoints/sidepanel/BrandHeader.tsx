import { useEffect, useId, useRef, useState } from "react";
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
  const headerRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = `masthead-menu-${useId().replace(/:/g, "")}`;

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
        triggerRef.current?.focus();
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
      if (event.key === "Tab") setMenuOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!headerRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onClick = (event: MouseEvent) => {
      if (!headerRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("click", onClick);
    requestAnimationFrame(() =>
      menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(),
    );
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("click", onClick);
    };
  }, [menuOpen]);

  const activate = () => {
    if (hasMenu) {
      setMenuOpen((current) => !current);
      return;
    }
    onAction();
  };

  return (
    <header ref={headerRef} className={`brand-header${compact ? " is-compact" : ""}`}>
      <div className="brand-lockup" aria-label="Perspectica">
        <PerspecticaMark />
        <span className="brand-wordmark">Perspectica</span>
      </div>
      <button
        ref={triggerRef}
        className="brand-action"
        type="button"
        aria-label={actionLabel}
        aria-expanded={hasMenu ? menuOpen : undefined}
        aria-haspopup={hasMenu ? "menu" : undefined}
        aria-controls={hasMenu ? menuId : undefined}
        onClick={activate}
      >
        {action === "menu" ? <MenuIcon /> : <CloseIcon />}
      </button>
      {hasMenu && menuOpen ? (
        <nav
          id={menuId}
          ref={menuRef}
          className="masthead-menu"
          role="menu"
          aria-label="Perspectica menu"
        >
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
