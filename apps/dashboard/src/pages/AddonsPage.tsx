import { useSearchParams } from 'react-router-dom';
import { AppHeader, BackLink, Tabs, type TabDef } from '@/components/ui';
import { BrowserAddonPanel } from './BrowserPage';
import { PlaywrightAddonPanel } from './PlaywrightAddonPanel';

const TABS = [
  { id: 'browser', label: '🌐 Browser' },
  { id: 'playwright', label: '🎭 Playwright' },
] as const satisfies ReadonlyArray<TabDef<string>>;
type TabId = (typeof TABS)[number]['id'];
const isTab = (v: string | null): v is TabId => TABS.some((t) => t.id === v);

/** Optional server components (docs/addons.md): the visible Browser (watch it, sign in once) and the agents' headless Playwright browser. */
export function AddonsPage() {
  const [params, setParams] = useSearchParams();
  const tab: TabId = isTab(params.get('tab')) ? (params.get('tab') as TabId) : 'browser';
  return (
    <>
      <BackLink href="/">← all tasks</BackLink>
      <AppHeader title="🧩 Add-ons" />
      <Tabs tabs={TABS} active={tab} onChange={(id) => setParams({ tab: id }, { replace: true })} />
      {tab === 'browser' ? <BrowserAddonPanel /> : <PlaywrightAddonPanel />}
    </>
  );
}
