import { useMemo, useState } from 'react';

export type MobileNavigationItem = {
  key: string;
  screen: string;
  icon: string;
  label: string;
};

type MobileNavigationProps = {
  items: readonly MobileNavigationItem[];
  activeKey: string;
  onSelect: (key: string) => void;
  onOpenSettings: () => void;
};

const PRIMARY_SCREENS = ['today', 'calendar', 'tasks', 'wiki'] as const;

export function MobileNavigation({ items, activeKey, onSelect, onOpenSettings }: MobileNavigationProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const uniqueItems = useMemo(() => {
    const seen = new Set<string>();
    return items.filter((item) => {
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    });
  }, [items]);
  const primaryItems = PRIMARY_SCREENS
    .map((screen) => uniqueItems.find((item) => item.screen === screen))
    .filter((item) => item !== undefined);
  const select = (key: string) => {
    onSelect(key);
    setMenuOpen(false);
  };

  return <>
    <nav className="mobile-navigation" aria-label="모바일 화면 탐색">
      {primaryItems.map((item) => <button type="button" data-active={activeKey === item.key} onClick={() => select(item.key)} key={item.key} aria-label={item.label}>
        <span>{item.icon}</span><small>{item.label}</small>
      </button>)}
      <button type="button" data-active={menuOpen} onClick={() => setMenuOpen(true)} aria-label="전체 화면 메뉴 열기">
        <span>☰</span><small>더보기</small>
      </button>
    </nav>
    {menuOpen && <div className="mobile-nav-backdrop" onMouseDown={() => setMenuOpen(false)}>
      <section className="mobile-nav-sheet" role="dialog" aria-modal="true" aria-label="전체 화면 메뉴" onMouseDown={(event) => event.stopPropagation()}>
        <header><strong>화면 이동</strong><button type="button" onClick={() => setMenuOpen(false)} aria-label="전체 화면 메뉴 닫기">×</button></header>
        <div>
          {uniqueItems.map((item) => <button type="button" data-active={activeKey === item.key} onClick={() => select(item.key)} key={item.key}>
            <span>{item.icon}</span><strong>{item.label}</strong>
          </button>)}
          <button type="button" onClick={() => { onOpenSettings(); setMenuOpen(false); }}><span>⚙️</span><strong>설정</strong></button>
        </div>
      </section>
    </div>}
  </>;
}
