import { useState } from 'react';
import { AppHeader, BackLink, Tabs, type TabDef } from '@/components/ui';
import { GeneralSettingsForm } from '@/components/settings/GeneralSettingsForm';
import { SecuritySettings } from '@/components/settings/SecuritySettings';
import { AccessSettings } from '@/components/settings/AccessSettings';
import { CloudflareAccessSettings } from '@/components/settings/CloudflareAccessSettings';
import { WebServerSettings } from '@/components/settings/WebServerSettings';
import { LiteLlmRoutes } from '@/components/settings/LiteLlmRoutes';
import { ProvidersManager } from '@/components/ProvidersManager';
import { McpManager } from '@/components/McpManager';
import { McpEndpointManager } from '@/components/settings/McpEndpointManager';
import { ChannelsManager } from '@/components/ChannelsManager';
import { UsersManager } from '@/components/UsersManager';
import { SchedulesManager } from '@/components/SchedulesManager';
import { VoiceSettings } from '@/components/settings/VoiceSettings';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'providers', label: 'Providers' },
  { id: 'litellm', label: 'LiteLLM' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'mcp-endpoint', label: 'MCP endpoint' },
  { id: 'channels', label: 'Channels' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'voice', label: 'Voice' },
  { id: 'users', label: 'Users' },
] as const satisfies ReadonlyArray<TabDef<string>>;

type TabId = (typeof TABS)[number]['id'];

export function SettingsPage() {
  const [tab, setTab] = useState<TabId>('general');

  return (
    <>
      <BackLink href="/">← all tasks</BackLink>
      <AppHeader title="⚙ Settings" />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'general' && (
        <>
          <SecuritySettings />
          <AccessSettings />
          <WebServerSettings />
          <CloudflareAccessSettings />
          <GeneralSettingsForm />
        </>
      )}
      {tab === 'providers' && <ProvidersManager />}
      {tab === 'litellm' && <LiteLlmRoutes />}
      {tab === 'mcp' && <McpManager />}
      {tab === 'mcp-endpoint' && <McpEndpointManager />}
      {tab === 'channels' && <ChannelsManager />}
      {tab === 'schedules' && <SchedulesManager />}
      {tab === 'voice' && <VoiceSettings />}
      {tab === 'users' && <UsersManager />}
    </>
  );
}
