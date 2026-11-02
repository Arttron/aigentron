import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { extensionOutdated, useExtension } from '@/lib/extension-bridge';
import { AppHeader, BackLink, Tabs, type TabDef } from '@/components/ui';
import { BrowserAddonPanel } from './BrowserPage';
import { PlaywrightAddonPanel } from './PlaywrightAddonPanel';
import { VoiceAddonPanel } from './VoiceAddonPanel';
import { ExtensionSettings } from '@/components/settings/ExtensionSettings';

const TABS = [
  { id: 'browser', label: '🌐 Browser' },
  { id: 'playwright', label: '🎭 Playwright' },
  { id: 'voice', label: '🎙 Voice' },
  { id: 'extension', label: '🔌 Extension' },
] as const satisfies ReadonlyArray<TabDef<string>>;
type TabId = (typeof TABS)[number]['id'];
const isTab = (v: string | null): v is TabId => TABS.some((t) => t.id === v);

/** Optional server components (docs/addons.md): the visible Browser, the agents' headless Playwright browser, local Voice, and the browser Extension (built with the project, configured per server). */
export function AddonsPage() {
  const [params, setParams] = useSearchParams();
  const tab: TabId = isTab(params.get('tab')) ? (params.get('tab') as TabId) : 'browser';
  // a dot on the Extension tab while a browser paired with this server runs an older extension
  const ext = useExtension();
  const [needsUpdate, setNeedsUpdate] = useState(false);
  useEffect(() => {
    void api
      .extensionInfo()
      .then((i) => setNeedsUpdate(i.devices.some((d) => d.outdated) || (ext.detected && extensionOutdated(ext.version, i.extensionVersion))))
      .catch(() => undefined);
  }, [ext.detected, ext.version, ext.connected]);
  const tabs = TABS.map((t) => (t.id === 'extension' && needsUpdate ? { ...t, label: `${t.label} ⚠ update` } : t));
  return (
    <>
      <BackLink href="/">← all tasks</BackLink>
      <AppHeader title="🧩 Add-ons" />
      <Tabs tabs={tabs} active={tab} onChange={(id) => setParams({ tab: id }, { replace: true })} />
      {tab === 'browser' && <BrowserAddonPanel />}
      {tab === 'playwright' && <PlaywrightAddonPanel />}
      {tab === 'voice' && <VoiceAddonPanel />}
      {tab === 'extension' && <ExtensionSettings />}
    </>
  );
}
